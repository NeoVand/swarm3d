import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { init, compute, draw, frame, target } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

const require = createRequire(import.meta.url);
const packagePath = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [packagePath] })).href
);
const { PNG } = await import(
	pathToFileURL(require.resolve('pngjs', { paths: [packagePath] })).href
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

const shaderNames = ['grid', 'simulate', 'metrics', 'history', 'boids', 'trails', 'world'];
const sources = Object.fromEntries(
	await Promise.all(
		shaderNames.map(async (name) => [
			name,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`) })).wgsl
		])
	)
);
const errors = [];
const gpu = await init({
	requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxStorageBuffersInVertexStage: 5 }
});
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const alloc = (name, size) =>
	gpu.device.createBuffer({
		size: Math.max(16, size),
		usage: ['storage', 'copy_src', 'copy_dst'],
		label: name
	});
const entries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const pipeline = Object.fromEntries(
	entries.map((entry) => [entry, compute(gpu, sources.grid, { entry })])
);
const measure = compute(gpu, sources.metrics, { entry: 'measure' });
const simulate = compute(gpu, sources.simulate, { entry: 'simulate' });
const writeHistory = compute(gpu, sources.history, { entry: 'write_history' });
const owned = [];
function createCase(scene, agents) {
	const count = agents.length,
		g = packing.gridDefinition(scene);
	const data = {
		scene,
		count,
		agents,
		config: alloc('config', 16384),
		particles: [alloc('state A', count * 64), alloc('state B', count * 64)],
		metrics: [alloc('metrics A', count * METRIC_BYTES), alloc('metrics B', count * METRIC_BYTES)],
		species: alloc('species', scene.species.length * 64 * 16),
		pairRules: alloc('pairs', scene.species.length ** 2 * 16),
		grid: alloc('grid', g.count * 12),
		indices: alloc('indices', count * 4),
		blocks: alloc('blocks', Math.ceil(g.count / 256) * 4),
		history: alloc('history', count * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES),
		side: 0,
		metricSide: 0,
		tick: 0,
		head: 0,
		valid: 1
	};
	owned.push(data);
	const bytes = packing.packParticles(agents, scene, 1);
	data.particles[0].write(bytes);
	data.particles[1].write(bytes);
	data.species.write(packing.packSpecies(scene));
	data.pairRules.write(packing.packPairRules(scene));
	const history = new Float32Array(count * 64 * 4);
	agents.forEach((a, i) => {
		for (let h = 0; h < 64; h++) history.set([...a.position, 1], (i * 64 + h) * 4);
	});
	data.history.write(history);
	configure(data);
	return data;
}
function configure(data, alpha = 1) {
	data.config.write(
		packing.packConfig(data.scene, {
			population: data.count,
			tick: data.tick,
			historyHead: data.head,
			validHistory: data.valid,
			smoothingAlpha: alpha
		})
	);
}
function build(data) {
	const resources = {
		config: data.config,
		particles: data.particles[data.side],
		grid: data.grid,
		indices: data.indices,
		blocks: data.blocks
	};
	for (const pass of Object.values(pipeline)) pass.set(resources);
	const cells = packing.gridDefinition(data.scene).count;
	pipeline.clear_grid.dispatch(Math.ceil(cells / 256));
	pipeline.count_particles.dispatch(Math.ceil(data.count / 256));
	pipeline.prefix_cells.dispatch(Math.ceil(cells / 256));
	pipeline.prefix_blocks.dispatch(1);
	pipeline.finish_prefix.dispatch(Math.ceil(cells / 256));
	pipeline.scatter_particles.dispatch(Math.ceil(data.count / 256));
}
function measured(data) {
	measure.set({
		config: data.config,
		particles: data.particles[data.side],
		previousMetrics: data.metrics[data.metricSide],
		nextMetrics: data.metrics[1 - data.metricSide],
		grid: data.grid,
		indices: data.indices,
		species: data.species
	});
	measure.dispatch(Math.ceil(data.count / 128));
	data.metricSide = 1 - data.metricSide;
}
function step(data) {
	data.tick++;
	configure(data);
	simulate.set({
		config: data.config,
		current: data.particles[data.side],
		next: data.particles[1 - data.side],
		grid: data.grid,
		indices: data.indices,
		metrics: data.metrics[data.metricSide],
		species: data.species,
		pairRules: data.pairRules
	});
	simulate.dispatch(Math.ceil(data.count / 128));
	data.side = 1 - data.side;
	build(data);
	measured(data);
	if (data.tick % packing.historyStride(data.scene) === 0) {
		data.head = (data.head + 1) % 64;
		data.valid = Math.min(64, data.valid + 1);
		configure(data);
		writeHistory.set({
			config: data.config,
			particles: data.particles[data.side],
			history: data.history,
			metrics: data.metrics[data.metricSide],
			species: data.species
		});
		writeHistory.dispatch(Math.ceil(data.count / 128));
	}
}
function disposeCase(data) {
	for (const key of ['config', 'species', 'pairRules', 'grid', 'indices', 'blocks', 'history'])
		data[key].destroy();
	for (const b of [...data.particles, ...data.metrics]) b.destroy();
}
function baseScene(n, world) {
	const scene = model.createDefaultScene();
	scene.world = world;
	scene.species = [scene.species[0]];
	scene.species[0].population = n;
	scene.species[0].perception = 2.7;
	scene.species[0].rebels.fraction = 0;
	scene.forces.enabled = false;
	scene.dynamics.noise = 0;
	scene.obstacles = [];
	scene.dynamics.metricSmoothingSeconds = 0;
	return scene;
}
try {
	const cases = [];
	const volume = baseScene(140, {
		kind: 'volume',
		shape: 'box',
		halfExtents: [9, 6.2, 8],
		boundaries: 'reflect'
	});
	const dense = Array.from({ length: 140 }, (_, i) => ({
		id: i + 1,
		birth: i + 1,
		speciesKey: volume.species[0].key,
		position: [(i % 7) * 0.06, (Math.floor(i / 7) % 5) * 0.05, Math.floor(i / 35) * 0.06],
		velocity: [1, 0, 0]
	}));
	cases.push(['dense volume', volume, dense]);
	const periodic = baseScene(128, {
		kind: 'volume',
		shape: 'box',
		halfExtents: [5.13, 4.19, 3.87],
		boundaries: 'periodic'
	});
	const edge = model.initializePopulation(periodic).agents.map((a, i) => ({
		...a,
		position: [i % 2 === 0 ? 5.1 : -5.1, (i % 5) * 0.2, (i % 7) * 0.12]
	}));
	cases.push(['periodic partial edge cells', periodic, edge]);
	const sphere = baseScene(180, { kind: 'surface', shape: 'sphere', radius: 12 });
	cases.push(['sphere intrinsic neighbors', sphere, model.initializePopulation(sphere).agents]);
	for (const [name, scene, agents] of cases) {
		const data = createCase(scene, agents);
		build(data);
		measured(data);
		const metrics = new Float32Array(
			await data.metrics[data.metricSide].read(data.count * METRIC_BYTES)
		);
		const grid = new Uint32Array(await data.grid.read(packing.gridDefinition(scene).count * 12));
		assert.equal(
			grid.subarray(0, packing.gridDefinition(scene).count).reduce((a, b) => a + b, 0),
			agents.length,
			'every agent is indexed'
		);
		const packedAgents = packing.unpackParticles(
			await data.particles[data.side].read(data.count * 64),
			scene,
			data.count
		);
		for (let i = 0; i < agents.length; i++) {
			const expected = model.allPairsNeighbors(
				scene.world,
				packedAgents,
				i,
				scene.species[0].perception
			).length;
			assert.equal(
				metrics[i * METRIC_STRIDE + 3],
				expected,
				`${name}: complete neighbors for ${i}`
			);
			assert.ok(
				metrics
					.subarray(i * METRIC_STRIDE, i * METRIC_STRIDE + METRIC_STRIDE)
					.every(Number.isFinite),
				`${name}: finite measurements`
			);
		}
		console.log(`PASS ${name}: ${agents.length} agents, all-pairs neighborhood agreement`);
		disposeCase(data);
	}
	const single = baseScene(1, { kind: 'surface', shape: 'sphere', radius: 12 });
	single.species[0].speed = 4;
	single.species[0].force = 0;
	single.species[0].trail.length = 2;
	const path = createCase(single, [
		{
			id: 1,
			birth: 1,
			speciesKey: single.species[0].key,
			position: [12, 0, 0],
			velocity: [0, 0, 4]
		}
	]);
	build(path);
	measured(path);
	for (let i = 0; i < 120; i++) step(path);
	const state = new Float32Array(await path.particles[path.side].read(64));
	const angle = (4 * single.dynamics.fixedDt * 120) / 12;
	assert.ok(
		Math.abs(state[0] - 12 * Math.cos(angle)) < 0.002 &&
			Math.abs(state[2] - 12 * Math.sin(angle)) < 0.002,
		'great-circle integration'
	);
	assert.ok(Math.abs(Math.hypot(...state.subarray(0, 3)) - 12) < 0.002, 'sphere radius');
	assert.ok(
		Math.abs(state[0] * state[4] + state[1] * state[5] + state[2] * state[6]) < 0.002,
		'tangent velocity'
	);
	const turning = new Float32Array(await path.metrics[path.metricSide].read(METRIC_BYTES));
	assert.ok(
		turning[1] < 0.003 && turning[2] < 0.003,
		'unforced covariant motion has zero turning/acceleration'
	);
	console.log('PASS sphere motion: 120 ticks, radius, tangency, great circle, transported turning');
	disposeCase(path);
	await mkdir('.cache', { recursive: true });
	for (const kind of ['volume', 'surface']) {
		const scene = model.createDefaultScene();
		scene.species = model.resizePopulation(scene, 1500).species;
		if (kind === 'surface') scene.world = { kind: 'surface', shape: 'sphere', radius: 14 };
		const data = createCase(scene, model.initializePopulation(scene).agents);
		build(data);
		measured(data);
		for (let i = 0; i < 30; i++) step(data);
		const width = 960,
			height = 640;
		const output = target(gpu, { size: [width, height], format: 'rgba8unorm', depth: true });
		const camera = perspectiveCamera({
			fov: 42,
			aspect: width / height,
			position: kind === 'surface' ? [30, 12, 32] : [34, 25, 42],
			target: [0, 0, 0],
			near: 0.1,
			far: 200
		});
		const cam = {
			viewProjection: camera.viewProjection,
			position: [...camera.worldPosition, 1],
			right: [1, 0, 0, 0],
			up: [0, 1, 0, 0]
		};
		const bindings = {
			config: data.config,
			particles: data.particles[data.side],
			metrics: data.metrics[data.metricSide],
			species: data.species,
			camera: cam
		};
		const body = draw(gpu, {
			shader: sources.boids,
			vertices: 36,
			instances: data.count,
			set: bindings
		});
		const trails = draw(gpu, {
			shader: sources.trails,
			vertices: 6 * 63,
			instances: data.count,
			depth: { write: false },
			blend: 'premultiplied',
			set: { ...bindings, history: data.history }
		});
		const world = draw(gpu, {
			shader: sources.world,
			vertices: 14400,
			depth: { write: false },
			blend: 'alpha',
			set: { config: data.config, camera: cam }
		});
		const shell = draw(gpu, {
			shader: sources.world,
			vertices: 10800,
			entry: { vertex: 'vs_shell', fragment: 'fs_shell' },
			writeMask: [],
			set: { config: data.config, camera: cam }
		});
		frame(gpu, (f) =>
			f.pass({ target: output, clear: [0.01, 0.015, 0.025, 1] }, (p) => {
				if (kind === 'surface') p.draw(shell);
				p.draw(world);
				p.draw(trails);
				p.draw(body);
			})
		);
		const pixels = await output.color.read({ mipLevel: 0, region: 'all' });
		let colored = 0;
		for (let i = 0; i < pixels.length; i += 4)
			if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 70) colored++;
		assert.ok(colored > 500, `${kind} render must contain visible geometry`);
		const png = new PNG({ width, height });
		png.data.set(pixels);
		await writeFile(`.cache/gpu-${kind}.png`, PNG.sync.write(png));
		console.log(`PASS ${kind} depth render: ${colored} visible pixels`);
		disposeCase(data);
	}
	for (const world of [
		{ kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' },
		{ kind: 'surface', shape: 'sphere', radius: 16 }
	]) {
		for (const n of [5000, 10000, 20000]) {
			const scene = model.resizePopulation(model.createDefaultScene(), n);
			scene.world = world;
			const data = createCase(scene, model.initializePopulation(scene).agents);
			build(data);
			measured(data);
			step(data);
			await gpu.gpu.queue.onSubmittedWorkDone();
			const start = performance.now();
			for (let i = 0; i < 8; i++) step(data);
			await gpu.gpu.queue.onSubmittedWorkDone();
			console.log(
				`BENCH ${world.kind} ${n}: ${((performance.now() - start) / 8).toFixed(2)} ms/tick including complete indexing, metrics, history and CPU submission`
			);
			disposeCase(data);
		}
	}
	await gpu.gpu.queue.onSubmittedWorkDone();
	await gpu.settled();
	assert.deepEqual(errors, [], 'No GPU validation errors');
	console.log('All native GPU checks passed. Browser and product checks run separately.');
} finally {
	gpu.dispose();
}
