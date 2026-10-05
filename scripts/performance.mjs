import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { init, compute, draw, effect, frame, target, sampler, timer } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

// No development server, RAF, UI, or concurrent swarm is involved in this experiment.
const require = createRequire(import.meta.url);
const dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing, createComputeRuntime, requiredMetricMask, trailRendering;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
	({ createComputeRuntime } = await vite.ssrLoadModule('/src/lib/gpu/compute-runtime.ts'));
	({ requiredMetricMask } = await vite.ssrLoadModule('/src/lib/gpu/metric-demand.ts'));
	trailRendering = await vite.ssrLoadModule('/src/lib/gpu/trail-render.ts');
} finally {
	await vite.close();
}
const METRIC_BYTES = packing.METRIC_BYTES;
const METRIC_STRIDE = METRIC_BYTES / Float32Array.BYTES_PER_ELEMENT;

const shaders = Object.fromEntries(
	await Promise.all(
		[
			'grid',
			'simulate',
			'metrics',
			'history',
			'boids',
			'trails',
			'world',
			'highlights',
			'bloom',
			'presentation'
		].map(async (name) => [
			name,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`) })).wgsl
		])
	)
);
const trailIndexPattern = trailRendering.trailQuadIndices();
if (process.argv.includes('--prepare-only')) {
	console.log(
		JSON.stringify({
			gpuInitialized: false,
			shaders: Object.keys(shaders),
			defaultMetricMask: requiredMetricMask(model.createDefaultScene()),
			sharedTrailIndexBytes: trailIndexPattern.byteLength
		})
	);
	process.exit(0);
}
let gpu;
try {
	gpu = await init({
		requiredFeatures: ['timestamp-query'],
		requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxStorageBuffersInVertexStage: 5 }
	});
} catch {
	gpu = await init({
		requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxStorageBuffersInVertexStage: 5 }
	});
}
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const renderTimer = gpu.gpu.features.has('timestamp-query') ? timer(gpu) : null;
const results = {
	recordedAt: new Date().toISOString(),
	adapter: {
		description: gpu.gpu.adapterInfo?.description,
		device: gpu.gpu.adapterInfo?.device,
		architecture: gpu.gpu.adapterInfo?.architecture
	},
	vgpu: '0.5.0',
	method:
		'Native GPU with production metric demand and indexed per-species trails. Compute throughput averages bounded batches; serial render latency waits each frame and reports median GPU timestamp samples after warmup. Unrequested neighbor measurements are not benchmarked or reported as zero. Not browser interactive FPS.',
	components: [],
	renders: [],
	motion: []
};
const unbatched = process.argv.includes('--unbatched');
results.computeMode = unbatched
	? 'vgpu dispatch per pass'
	: 'one native compute submission per tick';
const alloc = (label, size) =>
	gpu.device.createBuffer({
		label,
		size: Math.max(16, size),
		usage: ['storage', 'copy_src', 'copy_dst']
	});
const trailIndices = gpu.device.createBuffer({
	label: 'shared production trail quad indices',
	size: trailIndexPattern.byteLength,
	usage: ['index', 'copy_dst']
});
trailIndices.write(trailIndexPattern);
const entries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const gridPasses = Object.fromEntries(
	entries.map((entry) => [entry, compute(gpu, shaders.grid, { entry })])
);
const simulate = compute(gpu, shaders.simulate, { entry: 'simulate' }),
	measure = compute(gpu, shaders.metrics, { entry: 'measure' }),
	history = compute(gpu, shaders.history, { entry: 'write_history' });
async function createCase(population, kind, cluster = false) {
	const scene = model.resizePopulation(model.createDefaultScene(), population);
	if (kind === 'surface') {
		scene.world = { kind: 'surface', shape: 'sphere', radius: 16 };
		scene.species.forEach((s) => (s.perception = 2.8));
	}
	const agents = model.initializePopulation(scene).agents;
	if (cluster)
		agents.forEach((a) => {
			if (kind === 'volume') a.position = a.position.map((v) => v * 0.015);
			else {
				const p = [a.position[0] * 0.01, a.position[1] * 0.01, 16];
				const n = Math.hypot(...p);
				a.position = p.map((v) => (v * 16) / n);
				a.velocity = model.tangentProjection(a.velocity, a.position);
			}
		});
	const g = packing.gridDefinition(scene);
	const data = {
		scene,
		population,
		kind,
		cluster,
		metricMask: requiredMetricMask(scene),
		config: alloc('config', 16384),
		state: [alloc('state A', population * 64), alloc('state B', population * 64)],
		metrics: [
			alloc('metrics A', population * METRIC_BYTES),
			alloc('metrics B', population * METRIC_BYTES)
		],
		history: alloc('history', population * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES),
		grid: alloc('grid and peak occupancy metadata', (g.count * 3 + 1) * 4),
		indices: alloc('indices', population * 4),
		blocks: alloc('blocks', Math.ceil(g.count / 256) * 4),
		species: alloc('species', scene.species.length * 1024),
		pairs: alloc('pairs', scene.species.length ** 2 * 16),
		side: 0,
		metricSide: 0,
		tick: 0,
		head: 0,
		valid: 1
	};
	const packed = packing.packParticles(agents, scene, 1);
	data.state.forEach((b) => b.write(packed));
	data.species.write(packing.packSpecies(scene));
	data.pairs.write(packing.packPairRules(scene));
	const trail = new Float32Array(population * 64 * 4);
	agents.forEach((a, i) => {
		for (let age = 0; age < 64; age++) trail.set([...a.position, 1], (i * 64 + age) * 4);
	});
	data.history.write(trail);
	configure(data);
	bind(data);
	index(data);
	metrics(data);
	data.metricSide = 1;
	bind(data);
	data.batch = await createComputeRuntime(
		gpu,
		{
			grid: shaders.grid,
			simulation: shaders.simulate,
			metrics: shaders.metrics,
			history: shaders.history
		},
		{
			config: data.config,
			particles: data.state,
			metrics: data.metrics,
			history: data.history,
			grid: data.grid,
			indices: data.indices,
			blocks: data.blocks,
			species: data.species,
			pairRules: data.pairs
		}
	);
	return data;
}
function configure(d, alpha = 1) {
	d.config.write(
		packing.packConfig(d.scene, {
			population: d.population,
			tick: d.tick,
			historyHead: d.head,
			validHistory: d.valid,
			metricMask: d.metricMask,
			smoothingAlpha: alpha
		})
	);
}
function bind(d) {
	for (const p of Object.values(gridPasses))
		p.set({
			config: d.config,
			particles: d.state[d.side],
			grid: d.grid,
			indices: d.indices,
			blocks: d.blocks
		});
	simulate.set({
		config: d.config,
		current: d.state[d.side],
		next: d.state[1 - d.side],
		metrics: d.metrics[d.metricSide],
		species: d.species,
		pairRules: d.pairs,
		grid: d.grid,
		indices: d.indices
	});
	measure.set({
		config: d.config,
		particles: d.state[d.side],
		previousMetrics: d.metrics[d.metricSide],
		nextMetrics: d.metrics[1 - d.metricSide],
		grid: d.grid,
		indices: d.indices,
		species: d.species
	});
	history.set({
		config: d.config,
		particles: d.state[d.side],
		history: d.history,
		metrics: d.metrics[d.metricSide],
		species: d.species
	});
}
function index(d) {
	const cells = packing.gridDefinition(d.scene).count;
	gridPasses.clear_grid.dispatch(Math.ceil(cells / 256));
	gridPasses.count_particles.dispatch(Math.ceil(d.population / 256));
	gridPasses.prefix_cells.dispatch(Math.ceil(cells / 256));
	gridPasses.prefix_blocks.dispatch(1);
	gridPasses.finish_prefix.dispatch(Math.ceil(cells / 256));
	gridPasses.scatter_particles.dispatch(Math.ceil(d.population / 256));
}
function metrics(d) {
	measure.dispatch(Math.ceil(d.population / 128));
}
function tick(d) {
	d.tick++;
	if (!unbatched) {
		const sample = d.tick % packing.historyStride(d.scene) === 0;
		if (sample) {
			d.head = (d.head + 1) % 64;
			d.valid = Math.min(64, d.valid + 1);
		}
		configure(d);
		d.batch.tick(
			d.side,
			d.metricSide,
			d.population,
			packing.gridDefinition(d.scene).count,
			sample,
			d.metricMask
		);
		d.side = 1 - d.side;
		d.metricSide = 1 - d.metricSide;
		return;
	}
	configure(d);
	bind(d);
	simulate.dispatch(Math.ceil(d.population / 128));
	d.side = 1 - d.side;
	bind(d);
	index(d);
	metrics(d);
	d.metricSide = 1 - d.metricSide;
	history.set({
		config: d.config,
		particles: d.state[d.side],
		history: d.history,
		metrics: d.metrics[d.metricSide],
		species: d.species
	});
	if (d.tick % packing.historyStride(d.scene) === 0) {
		d.head = (d.head + 1) % 64;
		d.valid = Math.min(64, d.valid + 1);
		configure(d);
		history.dispatch(Math.ceil(d.population / 128));
	}
}
function free(d) {
	for (const value of Object.values(d)) if (value?.destroy) value.destroy();
	d.state.forEach((b) => b.destroy());
	d.metrics.forEach((b) => b.destroy());
}
async function timing(operation, iterations = 8) {
	for (let i = 0; i < 2; i++) operation();
	await gpu.gpu.queue.onSubmittedWorkDone();
	const start = performance.now();
	for (let i = 0; i < iterations; i++) operation();
	const encoded = performance.now();
	await gpu.gpu.queue.onSubmittedWorkDone();
	return {
		cpuMs: (encoded - start) / iterations,
		completedMs: (performance.now() - start) / iterations
	};
}
async function snapshot(d, seconds) {
	const values = new Float32Array(await d.state[d.side].read(d.population * 64)),
		measured = new Float32Array(await d.metrics[d.metricSide].read(d.population * METRIC_BYTES));
	const speed = Array.from({ length: d.population }, (_, i) =>
		Math.hypot(...values.subarray(i * 16 + 4, i * 16 + 7))
	).sort((a, b) => a - b);
	return {
		domain: d.kind,
		population: d.population,
		seconds,
		meanSpeed: speed.reduce((a, b) => a + b, 0) / speed.length,
		medianSpeed: speed[Math.floor(speed.length / 2)],
		p10Speed: speed[Math.floor(speed.length * 0.1)],
		metricMask: d.metricMask,
		meanNeighbors:
			(d.metricMask & (1 << 3)) !== 0
				? Array.from({ length: d.population }, (_, i) => measured[i * METRIC_STRIDE + 3]).reduce(
						(a, b) => a + b,
						0
					) / d.population
				: null
	};
}
async function rendering(d, width, height, trailsOn, bloom) {
	const stage = target(gpu, { size: [width, height], format: 'rgba16float', depth: true }),
		output = target(gpu, { size: [width, height], format: 'rgba8unorm' }),
		bright = target(gpu, {
			size: [Math.ceil(width / 4), Math.ceil(height / 4)],
			format: 'rgba16float'
		}),
		glow = target(gpu, { size: bright.size, format: 'rgba16float' });
	const camera = perspectiveCamera({
		fov: 42,
		aspect: width / height,
		position: [34, 25, 42],
		target: [0, 0, 0],
		near: 0.05,
		far: 200
	});
	const uniform = {
		viewProjection: camera.viewProjection,
		position: [...camera.worldPosition, 1],
		right: [1, 0, 0, 0],
		up: [0, 1, 0, 0]
	};
	const bindings = {
		config: d.config,
		particles: d.state[d.side],
		metrics: d.metrics[d.metricSide],
		species: d.species,
		camera: uniform
	};
	const body = draw(gpu, {
			shader: shaders.boids,
			vertices: 36,
			depth: { write: true },
			set: bindings
		}),
		trails = draw(gpu, {
			shader: shaders.trails,
			entry: { vertex: 'vs_indexed', fragment: 'fs_main' },
			geometry: {
				indexBuffer: trailIndices.gpu,
				indexFormat: 'uint16',
				indexCount: trailIndexPattern.length
			},
			depth: { write: false },
			blend: 'premultiplied',
			set: { ...bindings, history: d.history }
		}),
		shell = draw(gpu, {
			shader: shaders.world,
			vertices: 10800,
			entry: { vertex: 'vs_shell', fragment: 'fs_shell' },
			writeMask: [],
			set: { config: d.config, camera: uniform }
		});
	const imageSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
	const extract = effect(gpu, shaders.highlights, {
		set: { image: stage, imageSampler, glow: { texel: stage.texelSize } }
	});
	const blur = effect(gpu, shaders.bloom, {
		set: { image: bright, imageSampler, glow: { texel: bright.texelSize } }
	});
	const present = effect(gpu, shaders.presentation, {
		set: {
			image: stage,
			imageSampler,
			glow,
			presentation: { bloom: Number(bloom), exposure: 1 }
		}
	});
	await Promise.all([
		body.compile(stage),
		trails.compile(stage),
		shell.compile(stage),
		extract.compile(bright),
		blur.compile(glow),
		present.compile(output)
	]);
	const spans = [];
	const remove = renderTimer?.onResults((value) => spans.push(value));
	const headSeconds = (d.tick % packing.historyStride(d.scene)) * d.scene.dynamics.fixedDt;
	const sampleSeconds = packing.historyStride(d.scene) * d.scene.dynamics.fixedDt;
	const trailRanges = trailRendering
		.trailSpeciesRanges(d.scene)
		.map((range) => {
			const definition = d.scene.species.find((species) => species.key === range.key);
			return {
				...range,
				segments: trailRendering.trailSegmentCount(
					definition.trail.opacity > 0 && definition.trail.width > 0 ? definition.trail.length : 0,
					sampleSeconds,
					headSeconds,
					d.valid
				)
			};
		})
		.filter((range) => range.instances > 0 && range.segments > 0);
	const operation = () =>
		frame(gpu, (f) => {
			f.pass(
				{ target: stage, clear: [0.0006, 0.0009, 0.0015, 1], timer: renderTimer?.span('stage') },
				(p) => {
					if (d.kind === 'surface') p.draw(shell);
					if (trailsOn)
						for (const range of trailRanges)
							p.draw(trails, {
								instances: range.instances,
								firstInstance: range.firstInstance,
								indices: range.segments * 6
							});
					p.draw(body, { instances: d.population });
				}
			);
			if (bloom) {
				f.pass({ target: bright, timer: renderTimer?.span('highlights') }, extract);
				f.pass({ target: glow, timer: renderTimer?.span('blur') }, blur);
			}
			f.pass({ target: output, timer: renderTimer?.span('presentation') }, present);
		});
	let cpu = 0,
		completed = 0;
	for (let i = 0; i < 15; i++) {
		const started = performance.now();
		const submitted = operation();
		const encoded = performance.now();
		await Promise.all([submitted.done, gpu.gpu.queue.onSubmittedWorkDone()]);
		const finished = performance.now();
		await gpu.settled();
		if (i === 2) spans.length = 0;
		if (i >= 3) {
			cpu += encoded - started;
			completed += finished - started;
		}
	}
	remove?.();
	const median = (key) => {
		const values = spans
			.map((row) => row[key])
			.filter((v) => Number.isFinite(v))
			.sort((a, b) => a - b);
		return values.length ? values[Math.floor(values.length / 2)] : null;
	};
	const result = {
		domain: d.kind,
		population: d.population,
		width,
		height,
		trails: trailsOn,
		bloom,
		trailVertices: trailsOn
			? trailRanges.reduce((count, range) => count + range.instances * range.segments * 4, 0)
			: 0,
		trailIndices: trailsOn
			? trailRanges.reduce((count, range) => count + range.instances * range.segments * 6, 0)
			: 0,
		trailDrawCalls: trailsOn ? trailRanges.length : 0,
		metricMask: d.metricMask,
		cpuMs: cpu / 12,
		completedMs: completed / 12,
		gpuSamples: spans.length,
		stageGpuMs: median('stage'),
		presentationGpuMs: median('presentation'),
		highlightsGpuMs: median('highlights'),
		blurGpuMs: median('blur')
	};
	stage.color.destroy();
	stage.depth.destroy();
	output.color.destroy();
	bright.color.destroy();
	glow.color.destroy();
	return result;
}
try {
	const matrix = process.argv.includes('--matrix');
	for (const kind of ['volume', 'surface'])
		for (const n of matrix ? [5000, 10000, 20000] : [1000, 5000])
			for (const cluster of [false, true]) {
				// First quick experiment keeps pathological clusters small and explicit.
				if (!matrix && cluster && n > 1000) continue;
				const d = await createCase(n, kind, cluster);
				await gpu.gpu.queue.onSubmittedWorkDone();
				const stageOperations = {
					index: () => index(d),
					simulation: () => simulate.dispatch(Math.ceil(n / 128)),
					measurement: () => metrics(d),
					history: () => {
						d.tick = 2;
						configure(d);
						history.dispatch(Math.ceil(n / 128));
					}
				};
				const row = {
					domain: kind,
					population: n,
					distribution: cluster ? 'dense' : 'ordinary',
					cells: packing.gridDefinition(d.scene).count,
					metricMask: d.metricMask
				};
				for (const [name, op] of Object.entries(stageOperations)) row[name] = await timing(op);
				row.wholeTick = await timing(() => tick(d));
				results.components.push(row);
				console.log('COMPONENT ' + JSON.stringify(row));
				free(d);
			}
	for (const kind of ['volume', 'surface']) {
		const d = await createCase(1000, kind);
		results.motion.push(await snapshot(d, 0));
		for (const seconds of [1, 5, 20]) {
			const until = seconds * 60;
			while (d.tick < until) {
				tick(d);
				if (d.tick % 4 === 0) await gpu.gpu.queue.onSubmittedWorkDone();
			}
			const sample = await snapshot(d, seconds);
			results.motion.push(sample);
			console.log('MOTION ' + JSON.stringify(sample));
		}
		free(d);
	}
	for (const kind of ['volume', 'surface']) {
		const d = await createCase(5000, kind);
		for (let i = 0; i < 100; i++) {
			tick(d);
			if (i % 4 === 0) await gpu.gpu.queue.onSubmittedWorkDone();
		}
		for (const [width, height] of [
			[1280, 800],
			[2560, 1600]
		])
			for (const trails of [false, true])
				for (const bloom of [false, true]) {
					const row = await rendering(d, width, height, trails, bloom);
					results.renders.push(row);
					console.log('RENDER ' + JSON.stringify(row));
				}
		free(d);
	}
	await gpu.gpu.queue.onSubmittedWorkDone();
	await gpu.settled();
	assert.deepEqual(errors, [], 'GPU validation');
	await mkdir('.cache/performance', { recursive: true });
	const resultPath = `.cache/performance/native-${unbatched ? 'unbatched' : 'optimized'}.json`;
	await writeFile(resultPath, JSON.stringify(results, null, 2) + '\n');
	console.log(`Saved ${resultPath}; no application server was started.`);
} finally {
	renderTimer?.dispose();
	trailIndices.destroy();
	gpu.dispose();
}
