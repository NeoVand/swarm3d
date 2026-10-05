import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init } from 'vgpu/node';

// Diagnostic only: immutable completed states compare the current generic
// kernel with two bounded specializations. No production shader is changed.
const require = createRequire(import.meta.url);
const dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
} finally {
	await vite.close();
}
const LOCAL = 7;
const FAMILY = 351; // local, count, density, polarization and world heading
const timedMasks = process.argv.includes('--count-only') ? [15, 23] : [15, 23, 71, 87];
const outputPath = process.argv.includes('--count-only')
	? '.cache/metric-family-count-performance.json'
	: '.cache/metric-family-performance.json';
const raw = await readFile('src/lib/gpu/shaders/metrics.wgsl', 'utf8');
function replace(source, before, after) {
	assert.ok(source.includes(before), `Missing candidate anchor: ${before}`);
	return source.replace(before, after);
}
let constant = replace(
	raw,
	'@id(0) override force_complete: bool=false;',
	'@id(0) override force_complete: bool=false;\n@id(2) override fixed_mask: u32=0u;'
);
constant = replace(
	constant,
	'  if (!force_complete) {',
	'  if (fixed_mask!=0u) { requested=fixed_mask; }\n  else if (!force_complete) {'
);
assert.match(raw, /@id\(1\)\s+override\s+unit_family\s*:/);
const family = raw;
await mkdir('.cache/metric-family-sources', { recursive: true });
const sources = {
	baseline: (await resolveShader({ entry: resolve('src/lib/gpu/shaders/metrics.wgsl') })).wgsl,
	grid: (await resolveShader({ entry: resolve('src/lib/gpu/shaders/grid.wgsl') })).wgsl
};
for (const [name, source] of [
	['constant', constant],
	['family', family]
]) {
	const path = `.cache/metric-family-sources/${name}.wgsl`;
	await writeFile(
		path,
		source.replace('"./common.wgsl"', '"../../src/lib/gpu/shaders/common.wgsl"')
	);
	sources[name] = (await resolveShader({ entry: resolve(path) })).wgsl;
}
if (process.argv.includes('--prepare-only')) {
	console.log('Prepared bounded metric family candidates; no GPU acquired.');
	process.exit(0);
}
const gpu = await init({
	requiredFeatures: ['timestamp-query'],
	requiredLimits: { maxStorageBuffersPerShaderStage: 8 }
});
const device = gpu.gpu;
const errors = [];
gpu.onError((error) => errors.push(String(error)));
device.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const metricLayout = device.createBindGroupLayout({
	entries: Array.from({ length: 7 }, (_, binding) => ({
		binding,
		visibility: 4,
		buffer: { type: binding === 3 ? 'storage' : 'read-only-storage' }
	}))
});
const gridLayout = device.createBindGroupLayout({
	entries: Array.from({ length: 5 }, (_, binding) => ({
		binding,
		visibility: 4,
		buffer: { type: binding < 2 ? 'read-only-storage' : 'storage' }
	}))
});
async function pipeline(code, layout, entryPoint, constants) {
	const module = device.createShaderModule({ code });
	assert.deepEqual(
		(await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
		[]
	);
	return device.createComputePipelineAsync({
		layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
		compute: { module, entryPoint, constants }
	});
}
const pipelines = {
	baseline: await pipeline(sources.baseline, metricLayout, 'measure', { 0: 0 }),
	constant: await pipeline(sources.constant, metricLayout, 'measure', { 0: 0, 1: 0, 2: 87 }),
	family: await pipeline(sources.family, metricLayout, 'measure', { 0: 0, 1: 1 })
};
const gridEntries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const gridPipelines = {};
for (const entry of gridEntries)
	gridPipelines[entry] = await pipeline(sources.grid, gridLayout, entry);
const query = device.createQuerySet({ type: 'timestamp', count: 2 });
const timeResolve = device.createBuffer({ size: 256, usage: 512 | 4 });
const timeRead = device.createBuffer({ size: 16, usage: 1 | 8 });
const median = (values) => {
	const ordered = [...values].sort((a, b) => a - b);
	return (
		(ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2
	);
};
const results = {
	recordedAt: new Date().toISOString(),
	vgpu: '0.5.0',
	method:
		'Current production generic metrics versus diagnostic constant87 and basic neighborhood dependency-family specialization. Same completed state, prior metrics and complete index; metric-only and index+metric GPU pass timestamps; 16 immutable repetitions, 12 alternating paired samples.',
	controls: [],
	cases: []
};
function world(shape) {
	return {
		box: { kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'periodic' },
		sphere: { kind: 'surface', shape: 'sphere', radius: 16 },
		plane: { kind: 'surface', shape: 'plane', halfExtents: [18, 12], boundaries: 'periodic' },
		cylinder: { kind: 'surface', shape: 'cylinder', radius: 16, halfHeight: 12 },
		torus: { kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 }
	}[shape];
}
function cluster(position, geometry) {
	const [x, y, z] = position;
	if (geometry.shape === 'box') return [x * 0.03, y * 0.03, z * 0.03];
	if (geometry.shape === 'plane') return [x * 0.03, 0, z * 0.03];
	if (geometry.shape === 'sphere') {
		const q = [32 + x * 0.03, y * 0.03, z * 0.03];
		return q.map((v) => (v * geometry.radius) / Math.hypot(...q));
	}
	const a = Math.atan2(z, x) * 0.03;
	if (geometry.shape === 'cylinder')
		return [geometry.radius * Math.cos(a), y * 0.03, geometry.radius * Math.sin(a)];
	const b = Math.atan2(y, Math.hypot(x, z) - geometry.majorRadius) * 0.03;
	const r = geometry.majorRadius + geometry.tubeRadius * Math.cos(b);
	return [r * Math.cos(a), geometry.tubeRadius * Math.sin(b), r * Math.sin(a)];
}
function check(reference, candidate, count, mask) {
	const a = new Float32Array(reference),
		b = new Float32Array(candidate),
		ua = new Uint32Array(reference),
		ub = new Uint32Array(candidate);
	let differingWords = 0,
		maxError = 0;
	for (let i = 0; i < count; i++) {
		assert.equal(b[i * 16 + 15], mask, `valid mask ${i}`);
		for (let field = 0; field < 15; field++)
			if (mask & (1 << field)) {
				let error = Math.abs(a[i * 16 + field] - b[i * 16 + field]);
				if (field === 8) error = Math.min(error, Math.abs(1 - error));
				assert.ok(Number.isFinite(b[i * 16 + field]));
				assert.ok(
					error <= 5e-6 * Math.max(1, Math.abs(a[i * 16 + field])),
					`field ${field}, agent ${i}: ${a[i * 16 + field]} vs ${b[i * 16 + field]}`
				);
				if (field === 3) assert.equal(b[i * 16 + field], a[i * 16 + field]);
				if (ua[i * 16 + field] !== ub[i * 16 + field]) differingWords++;
				maxError = Math.max(maxError, error);
			}
	}
	return { mask, differingWords, maxError, bitwiseIdentical: differingWords === 0 };
}
async function run(shape, distribution, count, timed) {
	const scene = model.resizePopulation(model.createDefaultScene(), count);
	scene.world = world(shape);
	scene.seed = 0x8ea775ab;
	if (shape === 'torus') {
		for (const s of scene.species) s.perception = 2;
		scene.forces.radius = 2;
	}
	model.assertScene(scene);
	const agents = model.initializePopulation(scene).agents;
	if (distribution === 'clustered')
		for (const agent of agents) {
			agent.position = cluster(agent.position, scene.world);
			if (scene.world.kind === 'surface') {
				const normal = model.worldNormal(scene.world, agent.position);
				const d = agent.velocity.reduce((sum, v, k) => sum + v * normal[k], 0);
				agent.velocity = agent.velocity.map((v, k) => v - normal[k] * d);
			}
		}
	const definition = packing.gridDefinition(scene),
		owned = [];
	const alloc = (size) => {
		const b = gpu.device.createBuffer({
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(b);
		return b;
	};
	const b = {
		config: alloc(16384),
		particles: alloc(count * 64),
		prior: alloc(count * 64),
		baseline: alloc(count * 64),
		constant: alloc(count * 64),
		family: alloc(count * 64),
		grid: alloc(definition.count * 12 + 4),
		blocks: alloc(Math.ceil(definition.count / 256) * 4),
		indices: alloc(count * 4),
		species: alloc(scene.species.length * 1024)
	};
	const group = (layout, buffers) =>
		device.createBindGroup({
			layout,
			entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
		});
	const metricGroups = Object.fromEntries(
		['baseline', 'constant', 'family'].map((name) => [
			name,
			group(metricLayout, [b.config, b.particles, b.prior, b[name], b.grid, b.indices, b.species])
		])
	);
	const gridGroup = group(gridLayout, [b.config, b.particles, b.grid, b.indices, b.blocks]);
	const cellGroups = Math.ceil(definition.count / 256),
		gridCounts = [
			cellGroups,
			Math.ceil(count / 256),
			cellGroups,
			1,
			cellGroups,
			Math.ceil(count / 256)
		];
	const configure = (mask, alpha = 1) =>
		b.config.write(
			packing.packConfig(scene, {
				population: count,
				tick: 3,
				historyHead: 0,
				validHistory: 1,
				metricMask: mask,
				smoothingAlpha: alpha,
				selectedId: 0
			})
		);
	function index(pass) {
		pass.setBindGroup(0, gridGroup);
		gridEntries.forEach((entry, i) => {
			if (cellGroups !== 1 || (i !== 3 && i !== 4)) {
				pass.setPipeline(gridPipelines[entry]);
				pass.dispatchWorkgroups(gridCounts[i]);
			}
		});
	}
	async function dispatch(variant, timed = false, withIndex = false, onlyIndex = false) {
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass(
			timed
				? {
						timestampWrites: {
							querySet: query,
							beginningOfPassWriteIndex: 0,
							endOfPassWriteIndex: 1
						}
					}
				: {}
		);
		const repeats = timed ? 16 : 1;
		for (let i = 0; i < repeats; i++) {
			if (withIndex || onlyIndex) index(pass);
			if (!onlyIndex) {
				pass.setPipeline(pipelines[variant]);
				pass.setBindGroup(0, metricGroups[variant]);
				pass.dispatchWorkgroups(Math.ceil(count / 128));
			}
		}
		pass.end();
		if (timed) {
			encoder.resolveQuerySet(query, 0, 2, timeResolve, 0);
			encoder.copyBufferToBuffer(timeResolve, 0, timeRead, 0, 16);
		}
		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();
		if (!timed) return;
		await timeRead.mapAsync(1);
		const t = new BigUint64Array(timeRead.getMappedRange());
		const ms = Number(t[1] - t[0]) / 1e6 / repeats;
		timeRead.unmap();
		return ms;
	}
	try {
		const particles = packing.packParticles(agents, scene, 1),
			pf = new Float32Array(particles);
		for (let i = 0; i < count; i++)
			pf.set([pf[i * 16 + 4] * 0.9, pf[i * 16 + 5] * 0.85, pf[i * 16 + 6] * 1.1], i * 16 + 8);
		b.particles.write(particles);
		b.species.write(packing.packSpecies(scene));
		configure(87);
		await dispatch('baseline', false, false, true);
		await dispatch('baseline');
		const initial = await b.baseline.read(count * 64),
			prior = new Float32Array(initial.slice(0));
		for (let i = 0; i < count; i++) prior[i * 16 + 15] = FAMILY;
		b.prior.write(prior);
		const controls = [];
		for (const mask of timed ? timedMasks : [7, 15, 23, 71, 87, 95, 351]) {
			configure(mask);
			await dispatch('baseline');
			const reference = await b.baseline.read(count * 64);
			for (const variant of mask === 87 ? ['constant', 'family'] : ['family']) {
				await dispatch(variant);
				controls.push({
					variant,
					...check(reference, await b[variant].read(count * 64), count, mask)
				});
			}
		}
		if (!timed) {
			for (const mask of [15, 23, 71, 87]) {
				for (const alpha of [0.2, 0]) {
					const previous = new Float32Array(initial.slice(0));
					for (let i = 0; i < count; i++) {
						for (let field = 0; field < 15; field++)
							previous[i * 16 + field] =
								field === 0 ? previous[i * 16 + field] : previous[i * 16 + field] * 0.75 + 0.125;
						previous[i * 16 + 15] = alpha === 0 ? LOCAL : FAMILY;
					}
					b.prior.write(previous);
					configure(mask, alpha);
					await dispatch('baseline');
					const reference = await b.baseline.read(count * 64);
					for (const variant of mask === 87 ? ['constant', 'family'] : ['family']) {
						await dispatch(variant);
						controls.push({
							variant,
							alpha,
							...check(reference, await b[variant].read(count * 64), count, mask)
						});
					}
				}
			}
			results.controls.push({ shape, distribution, count, checks: controls });
			console.log(
				`PASS ${shape} ${distribution}: bounded family and fixed87 fields, continuing filters and alpha0 activation`
			);
		} else {
			b.prior.write(prior);
			const measurements = [];
			for (const mask of timedMasks) {
				configure(mask);
				for (const withIndex of [false, true]) {
					const variants =
						mask === 87 ? ['baseline', 'constant', 'family'] : ['baseline', 'family'];
					const times = Object.fromEntries(variants.map((variant) => [variant, []]));
					for (let warmup = 0; warmup < 3; warmup++)
						for (const variant of variants) await dispatch(variant, false, withIndex);
					for (let pair = 0; pair < 12; pair++)
						for (const variant of pair % 2 ? [...variants].reverse() : variants)
							times[variant].push(await dispatch(variant, true, withIndex));
					const medians = Object.fromEntries(
						Object.entries(times).map(([key, value]) => [key, median(value)])
					);
					measurements.push({ mask, withIndex, medianMs: medians, samples: times });
					console.log(
						`${shape} ${distribution} ${count} mask ${mask} ${withIndex ? 'index+metrics' : 'metrics'}: ${JSON.stringify(medians)}`
					);
				}
			}
			results.cases.push({ shape, distribution, count, controls, measurements });
		}
		await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
	} finally {
		await device.queue.onSubmittedWorkDone();
		for (const buffer of owned) buffer.destroy();
	}
}
try {
	for (const shape of ['box', 'sphere', 'plane', 'cylinder', 'torus'])
		for (const distribution of ['ordinary', 'clustered']) await run(shape, distribution, 64, false);
	for (const shape of ['box', 'sphere']) await run(shape, 'ordinary', 10000, true);
	for (const shape of ['box', 'sphere', 'plane', 'cylinder', 'torus'])
		await run(shape, 'clustered', 1000, true);
	await gpu.settled();
	assert.deepEqual(errors, []);
	console.log(`Bounded specialization diagnostics complete: ${outputPath}`);
} finally {
	await device.queue.onSubmittedWorkDone();
	query.destroy();
	timeResolve.destroy();
	timeRead.destroy();
	gpu.dispose();
}
