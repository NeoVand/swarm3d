import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { init, compute } from 'vgpu/node';

// Serial frozen dispatches in the exclusive GPU lane. Sparse and complete
// measurements use one physical snapshot, one complete grid and one kernel.
// This measures dispatch cost, not browser FPS or a changed physical solver.
const require = createRequire(import.meta.url);
const dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing, demand;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
	demand = await vite.ssrLoadModule('/src/lib/gpu/metric-demand.ts');
} finally {
	await vite.close();
}
const sources = Object.fromEntries(
	await Promise.all(
		['grid', 'metrics'].map(async (name) => [
			name,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`) })).wgsl
		])
	)
);
// Pin the original complete kernel so committing the optimization does not
// silently turn the reference into another sparse dispatch. An explicit ref
// supports later comparisons; both source and resolved commit are recorded.
await mkdir('.cache/metric-sources', { recursive: true });
const baselineEntry = '.cache/metric-sources/original.wgsl';
const baselineRef =
	process.argv
		.find((argument) => argument.startsWith('--baseline='))
		?.slice('--baseline='.length) ?? 'e6d98a76657c2dbee0bb0e2e72f6007dc47c68c8';
const baselineCommit = execFileSync('git', ['rev-parse', `${baselineRef}^{commit}`], {
	encoding: 'utf8'
}).trim();
await writeFile(
	baselineEntry,
	execFileSync('git', ['show', `${baselineCommit}:src/lib/gpu/shaders/metrics.wgsl`], {
		encoding: 'utf8'
	}).replace('"./common.wgsl"', '"../../src/lib/gpu/shaders/common.wgsl"')
);
sources.original = (await resolveShader({ entry: resolve(baselineEntry) })).wgsl;
assert.match(sources.metrics, /@id\(0\)\s+override\s+force_complete\s*:/);
if (process.argv.includes('--prepare-only')) {
	console.log('Prepared complete/sparse metric comparison; no GPU acquired.');
	process.exit(0);
}
const FULL = demand.ALL_METRICS_MASK;
const LOCAL = demand.LOCAL_METRICS_MASK;
const STRIDE = packing.METRIC_BYTES / 4;
const gpu = await init({
	requiredFeatures: ['timestamp-query'],
	requiredLimits: { maxStorageBuffersPerShaderStage: 8 }
});
const device = gpu.gpu;
const errors = [];
gpu.onError((error) => errors.push(String(error)));
device.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const query = device.createQuerySet({ type: 'timestamp', count: 2 });
const resolvedTime = device.createBuffer({ size: 256, usage: 512 | 4 });
const readTime = device.createBuffer({ size: 16, usage: 1 | 8 });
const layout = device.createBindGroupLayout({
	entries: Array.from({ length: 7 }, (_, binding) => ({
		binding,
		visibility: 4,
		buffer: { type: binding === 3 ? 'storage' : 'read-only-storage' }
	}))
});
const pipelines = {};
for (const [name, code] of [
	['original', sources.original],
	['requested', sources.metrics],
	['complete', sources.metrics]
]) {
	const module = device.createShaderModule({ label: `${name} measurement`, code });
	const compilationErrors = (await module.getCompilationInfo()).messages.filter(
		(message) => message.type === 'error'
	);
	assert.equal(compilationErrors.length, 0, JSON.stringify(compilationErrors));
	pipelines[name] = await device.createComputePipelineAsync({
		label: `${name} frozen measurement`,
		layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
		compute: {
			module,
			entryPoint: 'measure',
			constants: name === 'original' ? undefined : { 0: name === 'complete' ? 1 : 0 }
		}
	});
}
const gridEntries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const grids = Object.fromEntries(
	gridEntries.map((entry) => [entry, compute(gpu, sources.grid, { entry })])
);
const median = (values) => {
	const ordered = [...values].sort((a, b) => a - b);
	return (
		(ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2
	);
};
const results = {
	recordedAt: new Date().toISOString(),
	vgpu: '0.5.0',
	baselineCommit,
	method: {
		work: 'Preserved baseline commit original complete kernel versus demand-driven measurement dispatches; identical particle, prior metric and complete spatial grid snapshots. Excludes steering, indexing, history, rendering and scheduling.',
		timing:
			'WebGPU pass timestamps around 32 identical immutable dispatches, divided by 32 to resolve timer quantization; 3 warmups and 12 alternating paired samples per mask.',
		gate: 'Requested fields match original complete measurements within 5e-6*max(1,abs(reference)); counts and validity exact, float bit differences recorded. Selected identity has all 15 fields, unused fields retain values but lose validity, alpha=0 activation initializes fresh values without resmoothing continuing fields.'
	},
	controls: [],
	cases: []
};
async function dispatch(group, count, timed = false, variant = 'requested') {
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginComputePass(
		timed
			? {
					timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
				}
			: {}
	);
	pass.setPipeline(pipelines[variant]);
	pass.setBindGroup(0, group);
	const repetitions = timed ? 32 : 1;
	for (let i = 0; i < repetitions; i++) pass.dispatchWorkgroups(Math.ceil(count / 128));
	pass.end();
	if (timed) {
		encoder.resolveQuerySet(query, 0, 2, resolvedTime, 0);
		encoder.copyBufferToBuffer(resolvedTime, 0, readTime, 0, 16);
	}
	device.queue.submit([encoder.finish()]);
	await device.queue.onSubmittedWorkDone();
	if (!timed) return;
	await readTime.mapAsync(1);
	const stamps = new BigUint64Array(readTime.getMappedRange());
	const elapsed = Number(stamps[1] - stamps[0]) / 1e6 / repetitions;
	readTime.unmap();
	assert.ok(elapsed > 0 && Number.isFinite(elapsed));
	return elapsed;
}
function world(shape) {
	return {
		box: { kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'periodic' },
		sphere: { kind: 'surface', shape: 'sphere', radius: 16 },
		plane: { kind: 'surface', shape: 'plane', halfExtents: [18, 12], boundaries: 'periodic' },
		cylinder: { kind: 'surface', shape: 'cylinder', radius: 16, halfHeight: 12 },
		torus: { kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 }
	}[shape];
}
function clusteredPosition(position, geometry) {
	const [x, y, z] = position;
	if (geometry.shape === 'box') return [x * 0.03, y * 0.03, z * 0.03];
	if (geometry.shape === 'plane') return [x * 0.03, 0, z * 0.03];
	if (geometry.shape === 'sphere') {
		const q = [32 + x * 0.03, y * 0.03, z * 0.03];
		return q.map((value) => (value * geometry.radius) / Math.hypot(...q));
	}
	const angle = Math.atan2(z, x) * 0.03;
	if (geometry.shape === 'cylinder')
		return [geometry.radius * Math.cos(angle), y * 0.03, geometry.radius * Math.sin(angle)];
	const theta = Math.atan2(y, Math.hypot(x, z) - geometry.majorRadius) * 0.03;
	const radial = geometry.majorRadius + geometry.tubeRadius * Math.cos(theta);
	return [
		radial * Math.cos(angle),
		geometry.tubeRadius * Math.sin(theta),
		radial * Math.sin(angle)
	];
}
function close(actual, expected, message, field) {
	let difference = Math.abs(actual - expected);
	if ([8, 10, 11, 12].includes(field)) difference = Math.min(difference, Math.abs(1 - difference));
	assert.ok(
		difference <= 5e-6 * Math.max(1, Math.abs(expected)),
		`${message}: ${actual} vs ${expected} (error ${difference})`
	);
}
function checkFields(reference, candidate, count, mask, selected = -1) {
	const a = new Float32Array(reference),
		b = new Float32Array(candidate);
	const ua = new Uint32Array(reference),
		ub = new Uint32Array(candidate);
	let differingFloatWords = 0;
	for (let i = 0; i < count; i++) {
		const wanted = i === selected ? FULL : mask | LOCAL;
		assert.equal(b[i * STRIDE + 15], wanted, `agent ${i} validity`);
		for (let field = 0; field < 15; field++) {
			assert.ok(Number.isFinite(b[i * STRIDE + field]));
			if (wanted & (1 << field)) {
				if (field === 3)
					assert.equal(b[i * STRIDE + field], a[i * STRIDE + field], `agent ${i} complete count`);
				close(
					b[i * STRIDE + field],
					a[i * STRIDE + field],
					`agent ${i} requested field ${field}`,
					field
				);
				if (ub[i * STRIDE + field] !== ua[i * STRIDE + field]) differingFloatWords++;
			}
		}
	}
	return { mask, differingFloatWords, bitwiseIdentical: differingFloatWords === 0 };
}
async function runCase(shape, distribution, count, timed) {
	const scene = model.resizePopulation(model.createDefaultScene(), count);
	scene.world = world(shape);
	scene.seed = 0x8ea775ab;
	if (shape === 'torus') {
		scene.species.forEach((species) => (species.perception = 2));
		scene.forces.radius = 2;
	}
	model.assertScene(scene);
	const agents = model.initializePopulation(scene).agents;
	if (distribution === 'clustered') {
		for (const agent of agents) {
			agent.position = clusteredPosition(agent.position, scene.world);
			if (scene.world.kind === 'surface') {
				const normal = model.worldNormal(scene.world, agent.position);
				const dot = agent.velocity.reduce((sum, v, axis) => sum + v * normal[axis], 0);
				agent.velocity = agent.velocity.map((v, axis) => v - normal[axis] * dot);
			}
		}
	}
	const definition = packing.gridDefinition(scene);
	const owned = [];
	const alloc = (label, size) => {
		const buffer = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(buffer);
		return buffer;
	};
	const buffers = {
		config: alloc('full config', 16384),
		sparseConfig: alloc('requested config', 16384),
		particles: alloc('frozen particles', count * 64),
		prior: alloc('frozen prior metrics', count * packing.METRIC_BYTES),
		full: alloc('complete output', count * packing.METRIC_BYTES),
		sparse: alloc('requested output', count * packing.METRIC_BYTES),
		grid: alloc('complete grid', definition.count * 12),
		blocks: alloc('prefix', Math.ceil(definition.count / 256) * 4),
		indices: alloc('all particle indices', count * 4),
		species: alloc('physical species', scene.species.length * 1024)
	};
	const configure = (buffer, metricMask, smoothingAlpha = 1, selectedId = 0) =>
		buffer.write(
			packing.packConfig(scene, {
				population: count,
				tick: 3,
				historyHead: 0,
				validHistory: 1,
				metricMask,
				smoothingAlpha,
				selectedId
			})
		);
	const group = (config, output) =>
		device.createBindGroup({
			layout,
			entries: [
				config,
				buffers.particles,
				buffers.prior,
				output,
				buffers.grid,
				buffers.indices,
				buffers.species
			].map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
		});
	const fullGroup = group(buffers.config, buffers.full),
		sparseGroup = group(buffers.sparseConfig, buffers.sparse);
	try {
		const particles = packing.packParticles(agents, scene, 1);
		const pf = new Float32Array(particles);
		for (let i = 0; i < count; i++)
			pf.set([pf[i * 16 + 4] * 0.9, pf[i * 16 + 5] * 0.85, pf[i * 16 + 6] * 1.1], i * 16 + 8);
		buffers.particles.write(particles);
		buffers.species.write(packing.packSpecies(scene));
		configure(buffers.config, FULL);
		for (const pass of Object.values(grids))
			pass.set({
				config: buffers.config,
				particles: buffers.particles,
				grid: buffers.grid,
				indices: buffers.indices,
				blocks: buffers.blocks
			});
		const groups = Math.ceil(definition.count / 256);
		const counts = [groups, Math.ceil(count / 256), groups, 1, groups, Math.ceil(count / 256)];
		gridEntries.forEach((entry, i) => {
			if (groups !== 1 || (i !== 3 && i !== 4)) grids[entry].dispatch(counts[i]);
		});
		await dispatch(fullGroup, count, false, 'original');
		const reference = await buffers.full.read(count * packing.METRIC_BYTES);
		const completedPrior = new Float32Array(reference.slice(0));
		for (let i = 0; i < count; i++) completedPrior[i * STRIDE + 15] = FULL;
		buffers.prior.write(completedPrior);
		const checks = [];
		const masks = timed
			? process.argv.includes('--full-only')
				? [FULL]
				: [
						LOCAL,
						LOCAL | demand.metricBit('neighbor-count'),
						LOCAL | demand.metricBit('anisotropy')
					]
			: [LOCAL, ...model.METRICS.map((m) => LOCAL | demand.metricBit(m.id)), FULL];
		for (const mask of masks) {
			configure(buffers.sparseConfig, mask);
			await dispatch(sparseGroup, count, false, mask === FULL ? 'complete' : 'requested');
			checks.push(
				checkFields(reference, await buffers.sparse.read(count * packing.METRIC_BYTES), count, mask)
			);
		}
		if (!timed) {
			// Continuing filters receive identical ordinary smoothing.
			const prior = new Float32Array(reference.slice(0));
			for (let i = 0; i < count; i++)
				for (let field = 0; field < 15; field++) prior[i * STRIDE + field] *= 0.75;
			for (let i = 0; i < count; i++) prior[i * STRIDE + 15] = FULL;
			buffers.prior.write(prior);
			configure(buffers.config, FULL, 0.2);
			await dispatch(fullGroup, count, false, 'original');
			const filtered = await buffers.full.read(count * packing.METRIC_BYTES);
			for (const mask of masks) {
				configure(buffers.sparseConfig, mask, 0.2);
				await dispatch(sparseGroup, count, false, mask === FULL ? 'complete' : 'requested');
				checks.push({
					...checkFields(
						filtered,
						await buffers.sparse.read(count * packing.METRIC_BYTES),
						count,
						mask
					),
					filtered: true
				});
			}
			// Newly enabled anisotropy initializes at alpha=0, while turning stays.
			for (let i = 0; i < count; i++) {
				prior[i * STRIDE + 15] = LOCAL;
				prior[i * STRIDE + 1] = 1.25;
				prior[i * STRIDE + 5] = 9;
			}
			buffers.prior.write(prior);
			const activated = LOCAL | demand.metricBit('anisotropy');
			configure(buffers.sparseConfig, activated, 0);
			await dispatch(sparseGroup, count);
			const activatedOutput = new Float32Array(
				await buffers.sparse.read(count * packing.METRIC_BYTES)
			);
			const initial = new Float32Array(reference);
			for (let i = 0; i < count; i++) {
				assert.equal(activatedOutput[i * STRIDE + 1], 1.25);
				close(
					activatedOutput[i * STRIDE + 5],
					initial[i * STRIDE + 5],
					`activated anisotropy ${i}`,
					5
				);
				assert.equal(activatedOutput[i * STRIDE + 15], activated);
			}
			buffers.prior.write(activatedOutput);
			configure(buffers.sparseConfig, LOCAL, 0);
			await dispatch(sparseGroup, count);
			const dropped = new Float32Array(await buffers.sparse.read(count * packing.METRIC_BYTES));
			for (let i = 0; i < count; i++) {
				assert.equal(dropped[i * STRIDE + 5], activatedOutput[i * STRIDE + 5]);
				assert.equal(dropped[i * STRIDE + 15], LOCAL);
				dropped[i * STRIDE + 5] = 9;
			}
			buffers.prior.write(dropped);
			configure(buffers.sparseConfig, activated, 0);
			await dispatch(sparseGroup, count);
			const revived = new Float32Array(await buffers.sparse.read(count * packing.METRIC_BYTES));
			for (let i = 0; i < count; i++)
				close(revived[i * STRIDE + 5], initial[i * STRIDE + 5], `reactivated anisotropy ${i}`, 5);
			const selected = Math.floor(count / 3);
			buffers.prior.write(prior);
			configure(buffers.sparseConfig, LOCAL, 0, agents[selected].id);
			await dispatch(sparseGroup, count);
			const selectedOutput = new Float32Array(
				await buffers.sparse.read(count * packing.METRIC_BYTES)
			);
			for (let i = 0; i < count; i++) {
				assert.equal(selectedOutput[i * STRIDE + 15], i === selected ? FULL : LOCAL);
				for (let field = 3; i === selected && field < 15; field++)
					close(
						selectedOutput[i * STRIDE + field],
						initial[i * STRIDE + field],
						`selected fresh field ${field}`,
						field
					);
			}
			results.controls.push({
				shape,
				distribution,
				count,
				masks: checks,
				filtered: true,
				activationAlphaZero: true,
				reactivation: true,
				selectedFresh: true,
				requestedFieldsWithinTolerance: true
			});
			console.log(
				`PASS ${shape} ${distribution}: all 15 demand fields, ordinary filters, zero-alpha activation/reactivation and selected full inspection`
			);
		} else {
			buffers.prior.write(completedPrior);
			configure(buffers.config, FULL);
			const measured = [];
			for (const mask of masks) {
				const candidateVariant = mask === FULL ? 'complete' : 'requested';
				configure(buffers.sparseConfig, mask);
				for (let warmup = 0; warmup < 3; warmup++) {
					await dispatch(fullGroup, count, false, 'original');
					await dispatch(sparseGroup, count, false, candidateVariant);
				}
				const times = { full: [], sparse: [] };
				for (let pair = 0; pair < 12; pair++)
					for (const label of pair % 2 ? ['sparse', 'full'] : ['full', 'sparse'])
						times[label].push(
							await dispatch(
								label === 'full' ? fullGroup : sparseGroup,
								count,
								true,
								label === 'full' ? 'original' : candidateVariant
							)
						);
				const fullMs = median(times.full),
					sparseMs = median(times.sparse);
				measured.push({
					mask,
					fullMedianMs: fullMs,
					requestedMedianMs: sparseMs,
					reductionFraction: 1 - sparseMs / fullMs,
					samples: times
				});
				console.log(
					`${shape} ${distribution} ${count} mask=${mask}: ${fullMs.toFixed(3)} -> ${sparseMs.toFixed(3)} ms (${(100 * (1 - sparseMs / fullMs)).toFixed(1)}% less measurement time)`
				);
			}
			results.cases.push({
				shape,
				distribution,
				count,
				requestedFieldsWithinTolerance: true,
				gates: checks,
				measurements: measured
			});
		}
		await mkdir('.cache', { recursive: true });
		await writeFile(
			process.argv.includes('--full-only')
				? '.cache/metric-performance-full.json'
				: '.cache/metric-performance.json',
			`${JSON.stringify(results, null, 2)}\n`
		);
	} finally {
		await device.queue.onSubmittedWorkDone();
		for (const buffer of owned) buffer.destroy();
	}
}
try {
	for (const shape of ['box', 'sphere', 'plane', 'cylinder', 'torus'])
		for (const distribution of ['ordinary', 'clustered'])
			await runCase(shape, distribution, 64, false);
	for (const shape of ['box', 'sphere']) await runCase(shape, 'ordinary', 10000, true);
	for (const shape of ['box', 'sphere', 'plane', 'cylinder', 'torus'])
		await runCase(shape, 'clustered', 1000, true);
	await gpu.settled();
	assert.deepEqual(errors, [], 'no GPU validation errors');
	console.log(
		`Demand measurement correctness and timings complete: .cache/metric-performance${process.argv.includes('--full-only') ? '-full' : ''}.json`
	);
} finally {
	await device.queue.onSubmittedWorkDone();
	query.destroy();
	resolvedTime.destroy();
	readTime.destroy();
	gpu.dispose();
}
