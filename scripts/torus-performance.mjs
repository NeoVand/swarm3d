import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, compute } from 'vgpu/node';

// Run only in the team's exclusive GPU lane. This isolates immutable dispatches,
// not interactive FPS: simulation never feeds its output back into the next sample.
// Both variants share the same complete grid, neighbor order, inputs and bindings.
// Standard WebGPU pass timestamps exclude CPU encoding, fences and query readback.
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
const METRIC_BYTES = packing.METRIC_BYTES;
const METRIC_STRIDE = METRIC_BYTES / Float32Array.BYTES_PER_ELEMENT;

const sources = Object.fromEntries(
	await Promise.all(
		['grid', 'simulate', 'metrics'].map(async (name) => [
			name,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`) })).wgsl
		])
	)
);

function variants(source) {
	const deltaName = source.match(/fn (\w+__delta_world)\(/)?.[1];
	const relationName = source.match(/fn (\w+__torus_relation)\(/)?.[1];
	assert.ok(deltaName && relationName, 'resolved public geometry symbols');
	const displacementArgs =
		'p,neighbor.position.xyz,config[0].z,config[2].w,config[1].y,config[2].xyz,config[5].z';
	const relationArgs = 'p,neighbor.position.xyz,config[1].y,config[5].z';
	const duplicate = `let displacement=${deltaName}(${displacementArgs});
          var distance=length(displacement);
          if (config[0].z==4.0) { distance=${relationName}(${relationArgs}).distance; }`;
	const single = `var displacement=vec3f(0.0);
          var distance=0.0;
          if (config[0].z==4.0) {
            let relation=${relationName}(${relationArgs});
            displacement=relation.displacement;
            distance=relation.distance;
          } else {
            displacement=${deltaName}(${displacementArgs});
            distance=length(displacement);
          }`;
	// Support rerunning after a measured optimization has become production code.
	const original = source.includes(duplicate) ? duplicate : single;
	assert.ok(source.includes(original), 'recognized per-neighbor relation evaluation');
	assert.equal(source.split(original).length, 2, 'replace exactly one neighbor-loop block');
	return {
		baseline: source.replace(original, duplicate),
		candidate: source.replace(original, single)
	};
}
const shaders = { simulate: variants(sources.simulate), metrics: variants(sources.metrics) };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (process.argv.includes('--prepare-only')) {
	console.log(
		JSON.stringify(
			{
				prepared: true,
				shaderHashes: Object.fromEntries(
					Object.entries(shaders).map(([k, v]) => [
						k,
						{ baseline: sha256(v.baseline), candidate: sha256(v.candidate) }
					])
				)
			},
			null,
			2
		)
	);
	process.exit(0);
}

let gpu;
try {
	gpu = await init({
		requiredFeatures: ['timestamp-query'],
		requiredLimits: { maxStorageBuffersPerShaderStage: 8 }
	});
} catch (error) {
	assert.match(
		String(error),
		/FEATURE-UNSUPPORTED|timestamp-query/,
		'fallback only for unsupported timestamp queries'
	);
	gpu = await init({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
}
const device = gpu.gpu;
const errors = [];
gpu.onError((error) => errors.push(String(error)));
device.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const timestampEnabled = device.features.has('timestamp-query');
const querySet = timestampEnabled ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
// These are the standard GPUBufferUsage/GPUMapMode flags, including providers
// that expose WebGPU objects without installing the browser's global constants.
const queryResolve = timestampEnabled ? device.createBuffer({ size: 256, usage: 512 | 4 }) : null;
const queryRead = timestampEnabled ? device.createBuffer({ size: 16, usage: 1 | 8 }) : null;
const results = {
	recordedAt: new Date().toISOString(),
	vgpu: '0.5.0',
	adapter: {
		description: device.adapterInfo?.description,
		device: device.adapterInfo?.device,
		architecture: device.adapterInfo?.architecture
	},
	method: {
		work: 'Isolated immutable production simulation and measurement dispatches; same frozen complete grid and ordered neighbors. Excludes indexing, history, rendering and interactive scheduling.',
		timing: timestampEnabled
			? 'Beginning/end compute-pass GPU timestamps, nanoseconds converted to milliseconds. Each sample waits actual queue settlement and query readback; one dispatch in flight.'
			: 'Serial CPU submit-to-actual-queue-settlement latency; GPU timestamps unavailable. Includes driver/submission overhead.',
		warmupDispatchesPerVariant: 3,
		pairedSamplesPerKernel: 12,
		order:
			'Alternating baseline/candidate then candidate/baseline; cases ordinary 5k/10k/20k then dense 5k/10k/20k.',
		dense:
			'Seeded chart patch theta=pi +/- .75, phi=pi +/- .6 near the inner rim, crossing both seams. Same authored species/ranges as Ring Currents; complete neighbors without caps.',
		outputGate:
			'Every Float32 output finite and within 4e-6*max(1,abs(reference)); particle identities and neighbor counts exact. Shared immutable grid removes atomic scatter-order differences.'
	},
	shaderHashes: Object.fromEntries(
		Object.entries(shaders).map(([k, v]) => [
			k,
			{ baseline: sha256(v.baseline), candidate: sha256(v.candidate) }
		])
	),
	cases: []
};
const layouts = {
	simulate: [
		'read-only-storage',
		'read-only-storage',
		'storage',
		'read-only-storage',
		'read-only-storage',
		'read-only-storage',
		'read-only-storage',
		'read-only-storage'
	],
	metrics: [
		'read-only-storage',
		'read-only-storage',
		'read-only-storage',
		'storage',
		'read-only-storage',
		'read-only-storage',
		'read-only-storage'
	]
};
const pipelines = {};
async function makePipeline(kernel, label, code) {
	const module = device.createShaderModule({ label: `${kernel} ${label}`, code });
	const messages = (await module.getCompilationInfo()).messages.filter(
		(message) => message.type === 'error'
	);
	assert.equal(messages.length, 0, messages.map((m) => `${m.lineNum}:${m.message}`).join('\n'));
	const layout = device.createBindGroupLayout({
		entries: layouts[kernel].map((type, binding) => ({ binding, visibility: 4, buffer: { type } }))
	});
	const pipeline = await device.createComputePipelineAsync({
		label: `${kernel} ${label}`,
		layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
		compute: { module, entryPoint: kernel === 'metrics' ? 'measure' : 'simulate' }
	});
	return { pipeline, layout };
}
const gridEntries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const gridPasses = Object.fromEntries(
	gridEntries.map((entry) => [entry, compute(gpu, sources.grid, { entry })])
);
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length % 2
		? sorted[Math.floor(sorted.length / 2)]
		: (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const percentile = (values, fraction) =>
	[...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
function outputGate(kernel, baseline, candidate, count) {
	assert.equal(baseline.byteLength, candidate.byteLength);
	const a = new Float32Array(baseline),
		b = new Float32Array(candidate);
	const ua = new Uint32Array(baseline),
		ub = new Uint32Array(candidate);
	let maxAbsoluteDifference = 0,
		differingFloatWords = 0;
	for (let index = 0; index < a.length; index++) {
		if (kernel === 'simulate' && index % 16 >= 12) {
			assert.equal(ub[index], ua[index], `particle identity ${index}`);
			continue;
		}
		assert.ok(Number.isFinite(a[index]) && Number.isFinite(b[index]), `${kernel} finite ${index}`);
		const difference = Math.abs(b[index] - a[index]);
		assert.ok(
			difference <= 4e-6 * Math.max(1, Math.abs(a[index])),
			`${kernel} field ${index}: ${a[index]} vs ${b[index]}`
		);
		maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
		if (ua[index] !== ub[index]) differingFloatWords++;
	}
	if (kernel === 'metrics')
		for (let i = 0; i < count; i++)
			assert.equal(
				b[i * METRIC_STRIDE + 3],
				a[i * METRIC_STRIDE + 3],
				`complete neighbor count ${i}`
			);
	return {
		maxAbsoluteDifference,
		differingFloatWords,
		bitwiseIdentical: differingFloatWords === 0
	};
}
async function dispatch(kernel, variant, group, count, timed = true) {
	const start = performance.now();
	const encoder = device.createCommandEncoder({ label: `${kernel} ${variant} frozen sample` });
	const pass = encoder.beginComputePass(
		timed && querySet
			? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
			: {}
	);
	pass.setPipeline(pipelines[kernel][variant].pipeline);
	pass.setBindGroup(0, group);
	pass.dispatchWorkgroups(Math.ceil(count / 128));
	pass.end();
	if (timed && querySet) {
		encoder.resolveQuerySet(querySet, 0, 2, queryResolve, 0);
		encoder.copyBufferToBuffer(queryResolve, 0, queryRead, 0, 16);
	}
	device.queue.submit([encoder.finish()]);
	await device.queue.onSubmittedWorkDone();
	const completedMs = performance.now() - start;
	if (!timed || !querySet) return { gpuMs: null, completedMs };
	await queryRead.mapAsync(1);
	const stamps = new BigUint64Array(queryRead.getMappedRange());
	const gpuMs = Number(stamps[1] - stamps[0]) / 1e6;
	queryRead.unmap();
	assert.ok(gpuMs > 0 && Number.isFinite(gpuMs), 'positive settled GPU timestamp interval');
	return { gpuMs, completedMs };
}
async function runCase(count, dense) {
	const scene = model.resizePopulation(
		model.cloneScene(model.CURATED_SCENES.find((s) => s.id === 'ring-currents')),
		count
	);
	scene.seed = 0xc37ae19b;
	model.assertScene(scene);
	const agents = model.initializePopulation(scene).agents;
	if (dense) {
		const random = model.seededRandom(scene.seed ^ 0x7297ea33);
		for (const a of agents) {
			const oldChart = model.torusChart(scene.world, a.position);
			const components = model.torusComponents(oldChart, a.velocity);
			const chart = {
				theta: Math.PI + (random() * 2 - 1) * 0.75,
				phi: Math.PI + (random() * 2 - 1) * 0.6
			};
			a.position = model.torusPoint(scene.world, chart);
			a.velocity = model.torusWorldVector(chart, components);
		}
	}
	const definition = packing.gridDefinition(scene);
	const owned = [];
	const alloc = (label, size) => {
		const b = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(b);
		return b;
	};
	const buffers = {
		config: alloc('frozen config', 16384),
		particles: alloc('frozen particles', count * 64),
		previousMetrics: alloc('frozen prior metrics', count * METRIC_BYTES),
		grid: alloc('complete grid', definition.count * 12),
		indices: alloc('complete indices', count * 4),
		blocks: alloc('prefix blocks', Math.ceil(definition.count / 256) * 4),
		species: alloc('frozen species', scene.species.length * 1024),
		pairRules: alloc('frozen pair rules', scene.species.length ** 2 * 16),
		outputs: {
			simulate: {
				baseline: alloc('baseline particles', count * 64),
				candidate: alloc('candidate particles', count * 64)
			},
			metrics: {
				baseline: alloc('baseline metrics', count * METRIC_BYTES),
				candidate: alloc('candidate metrics', count * METRIC_BYTES)
			}
		}
	};
	try {
		const particles = packing.packParticles(agents, scene, 1);
		buffers.particles.write(particles);
		const config = packing.packConfig(scene, {
			population: count,
			tick: 77,
			simulationTime: 77 * scene.dynamics.fixedDt,
			historyHead: 0,
			validHistory: 1,
			smoothingAlpha: 1,
			sampleHistory: false
		});
		buffers.config.write(config);
		buffers.species.write(packing.packSpecies(scene));
		buffers.pairRules.write(packing.packPairRules(scene));
		for (const p of Object.values(gridPasses))
			p.set({
				config: buffers.config,
				particles: buffers.particles,
				grid: buffers.grid,
				indices: buffers.indices,
				blocks: buffers.blocks
			});
		const groups = Math.ceil(definition.count / 256);
		const gridDispatchCounts = [
			groups,
			Math.ceil(count / 256),
			groups,
			1,
			groups,
			Math.ceil(count / 256)
		];
		gridEntries.forEach((entry, i) => {
			if (groups !== 1 || (i !== 3 && i !== 4)) gridPasses[entry].dispatch(gridDispatchCounts[i]);
		});
		await device.queue.onSubmittedWorkDone();
		const group = (kernel, variant) => {
			const output = buffers.outputs[kernel][variant];
			const inputs =
				kernel === 'metrics'
					? [
							buffers.config,
							buffers.particles,
							buffers.previousMetrics,
							output,
							buffers.grid,
							buffers.indices,
							buffers.species
						]
					: [
							buffers.config,
							buffers.particles,
							output,
							buffers.grid,
							buffers.indices,
							buffers.previousMetrics,
							buffers.species,
							buffers.pairRules
						];
			return device.createBindGroup({
				layout: pipelines[kernel][variant].layout,
				entries: inputs.map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
			});
		};
		const bindings = Object.fromEntries(
			['metrics', 'simulate'].map((k) => [
				k,
				{ baseline: group(k, 'baseline'), candidate: group(k, 'candidate') }
			])
		);
		await dispatch('metrics', 'baseline', bindings.metrics.baseline, count, false);
		// Bootstrap once, then use the SAME immutable measured metrics for both kernels.
		const measured = await buffers.outputs.metrics.baseline.read(count * METRIC_BYTES);
		buffers.previousMetrics.write(measured);
		const initial = new Float32Array(measured);
		const neighborCounts = Array.from({ length: count }, (_, i) => initial[i * METRIC_STRIDE + 3]);
		const gridBytes = await buffers.grid.read(definition.count * 12);
		const cellCounts = new Uint32Array(gridBytes, 0, definition.count);
		const result = {
			count,
			distribution: dense ? 'dense-inner-rim' : 'ordinary-area-uniform',
			inputSha256: sha256(new Uint8Array(particles)),
			gridSha256: sha256(new Uint8Array(gridBytes)),
			gridCells: definition.count,
			maximumCellPopulation: Math.max(...cellCounts),
			meanNeighbors: neighborCounts.reduce((a, b) => a + b, 0) / count,
			maximumNeighbors: Math.max(...neighborCounts),
			kernels: {}
		};
		for (const kernel of ['metrics', 'simulate']) {
			for (const variant of ['baseline', 'candidate'])
				await dispatch(kernel, variant, bindings[kernel][variant], count, false);
			const [baseline, candidate] = await Promise.all([
				buffers.outputs[kernel].baseline.read(count * (kernel === 'metrics' ? METRIC_BYTES : 64)),
				buffers.outputs[kernel].candidate.read(count * (kernel === 'metrics' ? METRIC_BYTES : 64))
			]);
			const gate = outputGate(kernel, baseline, candidate, count);
			for (let warmup = 0; warmup < results.method.warmupDispatchesPerVariant; warmup++)
				for (const variant of warmup % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
					await dispatch(kernel, variant, bindings[kernel][variant], count, false);
			const samples = { baseline: [], candidate: [] };
			for (let pair = 0; pair < results.method.pairedSamplesPerKernel; pair++)
				for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
					samples[variant].push(await dispatch(kernel, variant, bindings[kernel][variant], count));
			const milliseconds = (variant) =>
				samples[variant].map((s) => (timestampEnabled ? s.gpuMs : s.completedMs));
			const baselineMs = milliseconds('baseline'),
				candidateMs = milliseconds('candidate');
			const pairedChanges = baselineMs.map((value, i) => 1 - candidateMs[i] / value);
			result.kernels[kernel] = {
				gate,
				baselineMedianMs: median(baselineMs),
				candidateMedianMs: median(candidateMs),
				medianReductionFraction: 1 - median(candidateMs) / median(baselineMs),
				pairedMedianReductionFraction: median(pairedChanges),
				pairedP10ReductionFraction: percentile(pairedChanges, 0.1),
				pairedP90ReductionFraction: percentile(pairedChanges, 0.9),
				samples
			};
			console.log(
				`${result.distribution} ${count} ${kernel}: ${median(baselineMs).toFixed(3)} -> ${median(candidateMs).toFixed(3)} ms (${(100 * (1 - median(candidateMs) / median(baselineMs))).toFixed(1)}%); output ${gate.bitwiseIdentical ? 'bitwise equal' : `max difference ${gate.maxAbsoluteDifference}`}`
			);
		}
		results.cases.push(result);
		await mkdir('.cache', { recursive: true });
		await writeFile('.cache/torus-performance.json', `${JSON.stringify(results, null, 2)}\n`);
	} finally {
		await device.queue.onSubmittedWorkDone();
		for (const b of owned) b.destroy();
	}
}
try {
	for (const kernel of ['metrics', 'simulate']) {
		pipelines[kernel] = {};
		for (const variant of ['baseline', 'candidate'])
			pipelines[kernel][variant] = await makePipeline(kernel, variant, shaders[kernel][variant]);
	}
	for (const dense of [false, true])
		for (const count of [5000, 10000, 20000]) await runCase(count, dense);
	await device.queue.onSubmittedWorkDone();
	await gpu.settled();
	assert.deepEqual(errors, [], 'no GPU validation/readback errors');
	console.log(
		'Frozen torus output/timing comparison complete; results: .cache/torus-performance.json'
	);
} finally {
	await device.queue.onSubmittedWorkDone();
	querySet?.destroy();
	queryResolve?.destroy();
	queryRead?.destroy();
	await gpu.dispose();
}
