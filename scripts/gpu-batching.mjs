import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, compute } from 'vgpu/node';

// Compare the production batched encoder to vgpu's public per-dispatch path.
// This tests ordering, binding sides, configuration snapshots and replacement
// resources; kernel mathematics has a separate all-pairs oracle suite.
const require = createRequire(import.meta.url);
const packagePath = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [packagePath] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing, createComputeRuntime;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
	({ createComputeRuntime } = await vite.ssrLoadModule('/src/lib/gpu/compute-runtime.ts'));
} finally {
	await vite.close();
}
const METRIC_BYTES = packing.METRIC_BYTES;
const METRIC_STRIDE = METRIC_BYTES / Float32Array.BYTES_PER_ELEMENT;

const shaders = Object.fromEntries(
	await Promise.all(
		Object.entries({
			grid: 'grid',
			simulation: 'simulate',
			metrics: 'metrics',
			history: 'history'
		}).map(async ([key, name]) => [
			key,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`) })).wgsl
		])
	)
);
const gpu = await init({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));

// Node's provider normally installs these WebGPU constants during init.
// Keep the standard bit mask available for providers that omit this global.
const previousShaderStage = globalThis.GPUShaderStage;
if (!previousShaderStage)
	Object.defineProperty(globalThis, 'GPUShaderStage', {
		value: Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }),
		configurable: true
	});
let submissions = 0;
const countedQueue = new Proxy(gpu.gpu.queue, {
	get(queue, key) {
		if (key === 'submit')
			return (commands) => {
				submissions++;
				return queue.submit(commands);
			};
		const value = Reflect.get(queue, key, queue);
		return typeof value === 'function' ? value.bind(queue) : value;
	}
});
const countedDevice = new Proxy(gpu.gpu, {
	get(device, key) {
		if (key === 'queue') return countedQueue;
		const value = Reflect.get(device, key, device);
		return typeof value === 'function' ? value.bind(device) : value;
	}
});
const countedGpu = { ...gpu, gpu: countedDevice };
const entries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const reference = {
	grid: Object.fromEntries(entries.map((entry) => [entry, compute(gpu, shaders.grid, { entry })])),
	simulation: compute(gpu, shaders.simulation, { entry: 'simulate' }),
	metrics: compute(gpu, shaders.metrics, { entry: 'measure' }),
	history: compute(gpu, shaders.history, { entry: 'write_history' })
};
const flatBuffers = (buffers) => [
	...buffers.particles,
	...buffers.metrics,
	...['config', 'history', 'grid', 'indices', 'blocks', 'species', 'pairRules'].map(
		(key) => buffers[key]
	)
];

function sceneFor(world, count) {
	const scene = model.createDefaultScene();
	scene.seed = 0x8c31ef11;
	scene.world = world;
	scene.dynamics.fixedDt = 1 / 60;
	scene.dynamics.noise = 0.03;
	scene.dynamics.collision = 0.7;
	scene.dynamics.metricSmoothingSeconds = 0.1;
	scene.forces.enabled = false;
	scene.obstacles = [];
	scene.species.forEach((species, i) => {
		species.population = i ? Math.floor(count / 2) : Math.ceil(count / 2);
		species.size = 0.045 + i * 0.015;
		species.speed = 3.5;
		species.cruiseSpeed = 1.05;
		species.force = 3;
		species.perception = 2.2 + i * 0.3;
		species.alignment = 0.7;
		species.cohesion = 0.25;
		species.separation = 1.6;
		species.rebels.fraction = 0;
		species.trail.length = 1.5 * 63 * scene.dynamics.fixedDt;
		species.metricRules = [];
	});
	const curve = {
		points: [
			[0, 0],
			[1, 1]
		]
	};
	scene.speciesRules = [
		{
			id: 'fallback',
			from: scene.species[0].key,
			to: '*',
			behavior: 'align',
			strength: 0.2,
			radius: 3.8
		},
		{
			id: 'explicit',
			from: scene.species[0].key,
			to: scene.species[1].key,
			behavior: 'orbit',
			strength: 0.3,
			radius: 3.1
		},
		{
			id: 'return',
			from: scene.species[1].key,
			to: scene.species[0].key,
			behavior: 'cohere',
			strength: 0.2,
			radius: 3.4
		}
	];
	scene.species[0].metricRules = [
		{
			id: 'read-speed',
			metric: 'speed',
			role: 'neighbor',
			range: [0, 3.5],
			curve,
			behavior: 'align',
			strength: 0.35,
			radius: 3.5
		}
	];
	scene.species[1].metricRules = [
		{
			id: 'read-self',
			metric: 'acceleration',
			role: 'self',
			range: [0, 3],
			curve,
			behavior: 'flee',
			strength: 0.15,
			radius: 3
		},
		{
			id: 'read-difference',
			metric: 'anisotropy',
			role: 'difference',
			range: [0, 1],
			curve,
			behavior: 'orbit',
			strength: 0.1,
			radius: 2.6
		}
	];
	return scene;
}

function agentsFor(scene, dense = false, seams = false) {
	return model.initializePopulation(scene).agents.map((agent, i) => {
		const id = 0x1000001 + i * 17;
		if (dense) {
			// Uneven deterministic clusters avoid undefined bearings at an exact
			// zero centroid while forcing more neighbors than legacy cell caps.
			const displacement = [
				Math.sin(i * 1.91) * 0.31 + (i % 7) * 0.003,
				Math.sin(i * 0.71) * 0.19,
				Math.cos(i * 2.37) * 0.29 + (i % 11) * 0.002
			];
			if (scene.world.kind === 'surface') {
				const center = [0, scene.world.radius, 0];
				agent.position = model.sphereExp(
					center,
					[displacement[0], 0, displacement[2]],
					scene.world.radius
				);
				agent.velocity = model.sphereTransport(
					[0.13 + (i % 5) * 0.01, 0, 0.06],
					center,
					agent.position
				);
			} else {
				agent.position = displacement;
				agent.velocity = [0.13 + (i % 5) * 0.01, 0.05, 0.06];
			}
		} else if (seams) {
			const half = scene.world.halfExtents;
			agent.position = half.map(
				(extent, axis) => (i & (1 << axis) ? 1 : -1) * (extent - 0.015 - (i % 13) * 0.011)
			);
			agent.velocity = agent.position.map((value, axis) => Math.sign(value) * (1.4 - axis * 0.2));
		}
		if (i % 9 === 0) agent.velocity = [0, 0, 0];
		return { ...agent, id, birth: id };
	});
}

function allocateCase(scene, agents, index) {
	const owned = new Set();
	const allocate = (label, size) => {
		const buffer = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.add(buffer);
		return buffer;
	};
	const count = agents.length;
	const grid = packing.gridDefinition(scene);
	const capacity = count;
	const makeBuffers = (suffix) => ({
		config: allocate(`${suffix} config`, 16384),
		particles: [
			allocate(`${suffix} particles A`, capacity * 64),
			allocate(`${suffix} particles B`, capacity * 64)
		],
		metrics: [
			allocate(`${suffix} metrics A`, capacity * METRIC_BYTES),
			allocate(`${suffix} metrics B`, capacity * METRIC_BYTES)
		],
		history: allocate(
			`${suffix} history`,
			capacity * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES
		),
		grid: allocate(`${suffix} grid`, grid.count * 12),
		indices: allocate(`${suffix} indices`, capacity * 4),
		blocks: allocate(`${suffix} blocks`, Math.ceil(grid.count / 256) * 4),
		species: allocate(`${suffix} species`, scene.species.length * 64 * 16),
		pairRules: allocate(`${suffix} pair rules`, scene.species.length ** 2 * 16)
	});
	const data = {
		scene,
		count,
		grid,
		stride: packing.historyStride(scene),
		owned,
		allocate,
		reference: makeBuffers('reference'),
		batched: makeBuffers('batched'),
		side: index % 2,
		metricSide: (index + 1) % 2,
		tick: 0x1000001,
		simulationTime: 0,
		head: 63,
		valid: 1,
		historyTicks: 0,
		uploads: 0,
		generation: 19
	};
	assert.equal(data.stride, 2, 'fixture samples history every second actual tick');
	const particles = packing.packParticles(agents, scene, data.generation);
	const metrics = new Float32Array(count * METRIC_STRIDE);
	for (let i = 0; i < count; i++) metrics[i * METRIC_STRIDE] = -1;
	const history = new Float32Array(count * 64 * 4);
	for (let i = 0; i < count; i++)
		for (let sample = 0; sample < 64; sample++)
			history.set([...agents[i].position, data.generation], (i * 64 + sample) * 4);
	for (const buffers of [data.reference, data.batched]) {
		for (const buffer of buffers.particles) buffer.write(particles);
		for (const buffer of buffers.metrics) buffer.write(metrics);
		buffers.history.write(history);
		buffers.species.write(packing.packSpecies(scene));
		buffers.pairRules.write(packing.packPairRules(scene));
	}
	return data;
}

function configure(data, alpha, sampleHistory = false) {
	const values = packing.packConfig(
		data.scene,
		{
			population: data.count,
			tick: data.tick,
			simulationTime: data.simulationTime,
			runGeneration: data.generation,
			historyHead: data.head,
			validHistory: data.valid,
			historyElapsed: data.historyTicks * data.scene.dynamics.fixedDt,
			sampleHistory,
			smoothingAlpha: alpha
		},
		{ grid: data.grid, stride: data.stride }
	);
	data.reference.config.write(values);
	data.batched.config.write(values);
	data.uploads++;
}
function buildReference(data) {
	const buffers = data.reference;
	const bindings = {
		config: buffers.config,
		particles: buffers.particles[data.side],
		grid: buffers.grid,
		indices: buffers.indices,
		blocks: buffers.blocks
	};
	for (const pass of Object.values(reference.grid)) pass.set(bindings);
	const cellGroups = Math.ceil(data.grid.count / 256);
	const counts = [
		cellGroups,
		Math.ceil(data.count / 256),
		cellGroups,
		1,
		cellGroups,
		Math.ceil(data.count / 256)
	];
	// Deliberately run both optional passes here, so one-block batching is
	// independently compared with the complete public-dispatch reference.
	entries.forEach((entry, i) => reference.grid[entry].dispatch(counts[i]));
}
function measureReference(data) {
	const buffers = data.reference;
	reference.metrics.set({
		config: buffers.config,
		particles: buffers.particles[data.side],
		previousMetrics: buffers.metrics[data.metricSide],
		nextMetrics: buffers.metrics[1 - data.metricSide],
		grid: buffers.grid,
		indices: buffers.indices,
		species: buffers.species
	});
	reference.metrics.dispatch(Math.ceil(data.count / 128));
}
function oneSubmission(operation, label) {
	const before = submissions;
	operation();
	assert.equal(submissions - before, 1, `${label}: exactly one actual queue submission`);
}
function bootstrap(data, runtime, alpha = 1) {
	const uploads = data.uploads;
	configure(data, alpha);
	oneSubmission(
		() => runtime.bootstrap(data.side, data.metricSide, data.count, data.grid.count),
		'bootstrap'
	);
	buildReference(data);
	measureReference(data);
	data.metricSide = 1 - data.metricSide;
	assert.equal(data.uploads - uploads, 1, 'bootstrap uses one configuration snapshot');
}
function tick(data, runtime, alpha) {
	data.tick++;
	data.simulationTime += data.scene.dynamics.fixedDt;
	const sampleHistory = ++data.historyTicks >= data.stride;
	if (sampleHistory) {
		data.historyTicks = 0;
		data.head = (data.head + 1) % 64;
		data.valid = Math.min(64, data.valid + 1);
	}
	const uploads = data.uploads;
	configure(data, alpha, sampleHistory);
	oneSubmission(
		() => runtime.tick(data.side, data.metricSide, data.count, data.grid.count, sampleHistory),
		'physical tick'
	);
	const buffers = data.reference;
	reference.simulation.set({
		config: buffers.config,
		current: buffers.particles[data.side],
		next: buffers.particles[1 - data.side],
		metrics: buffers.metrics[data.metricSide],
		grid: buffers.grid,
		indices: buffers.indices,
		species: buffers.species,
		pairRules: buffers.pairRules
	});
	reference.simulation.dispatch(Math.ceil(data.count / 128));
	data.side = 1 - data.side;
	buildReference(data);
	measureReference(data);
	data.metricSide = 1 - data.metricSide;
	if (sampleHistory) {
		reference.history.set({
			config: buffers.config,
			particles: buffers.particles[data.side],
			history: buffers.history,
			metrics: buffers.metrics[data.metricSide],
			species: buffers.species
		});
		reference.history.dispatch(Math.ceil(data.count / 128));
	}
	assert.equal(data.uploads - uploads, 1, 'physical tick uses one configuration snapshot');
	return sampleHistory;
}

const circularMetrics = new Set([8, 10, 11, 12]);
const metricTolerances = [
	3e-5, 3e-3, 3e-3, 0, 3e-5, 4e-4, 3e-5, 3e-4, 3e-5, 5e-5, 1e-4, 1e-4, 2e-4, 3e-4, 3e-5
];
function compareFloat(actual, expected, tolerance, message, circular = false) {
	assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${message}: finite values`);
	let error = Math.abs(actual - expected);
	if (circular) error = Math.min(error, 1 - error);
	assert.ok(
		error <= tolerance,
		`${message}: batched=${actual}, reference=${expected}, error=${error}, tolerance=${tolerance}`
	);
	return error;
}
function gridMembership(data, gridBytes, indexBytes, particleBytes) {
	const cells = new Uint32Array(gridBytes);
	const indices = new Uint32Array(indexBytes);
	const ids = new Uint32Array(particleBytes);
	const positions = new Float32Array(particleBytes);
	const expected = Array.from({ length: data.grid.count }, () => []);
	for (let i = 0; i < data.count; i++) {
		const xyz = [0, 1, 2].map((axis) =>
			Math.max(
				0,
				Math.min(
					data.grid.dims[axis] - 1,
					Math.floor((positions[i * 16 + axis] - data.grid.min[axis]) / data.grid.width)
				)
			)
		);
		expected[xyz[0] + data.grid.dims[0] * (xyz[1] + data.grid.dims[1] * xyz[2])].push(
			ids[i * 16 + 12]
		);
	}
	let offset = 0;
	const seen = new Set();
	const membership = expected.map((agents, cell) => {
		assert.equal(cells[cell], agents.length, 'complete grid cell count');
		assert.equal(cells[data.grid.count + cell], offset, 'exclusive cell offset');
		assert.equal(
			cells[data.grid.count * 2 + cell],
			agents.length,
			'scatter cursor equals complete count'
		);
		const values = [...indices.subarray(offset, offset + agents.length)]
			.map((index) => {
				assert.ok(
					index < data.count && !seen.has(index),
					'each active particle occupies exactly one index slot'
				);
				seen.add(index);
				return ids[index * 16 + 12];
			})
			.sort((a, b) => a - b);
		assert.deepEqual(
			values,
			agents.sort((a, b) => a - b),
			'complete sorted neighbor membership'
		);
		offset += agents.length;
		return values;
	});
	assert.equal(offset, data.count, 'no population truncation');
	return membership;
}
async function compareSnapshots(data, label, sampled = false, previousHistory) {
	const read = async (buffers) => {
		const [particles, metrics, history, grid, indices] = await Promise.all([
			Promise.all(buffers.particles.map((buffer) => buffer.read(data.count * 64))),
			Promise.all(buffers.metrics.map((buffer) => buffer.read(data.count * METRIC_BYTES))),
			buffers.history.read(data.count * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES),
			buffers.grid.read(data.grid.count * 12),
			buffers.indices.read(data.count * 4)
		]);
		return { particles, metrics, history, grid, indices };
	};
	const [actual, expected] = await Promise.all([read(data.batched), read(data.reference)]);
	let maximumPositionError = 0,
		maximumMetricError = 0;
	for (let side = 0; side < 2; side++) {
		const a = new Float32Array(actual.particles[side]),
			b = new Float32Array(expected.particles[side]);
		const ai = new Uint32Array(actual.particles[side]),
			bi = new Uint32Array(expected.particles[side]);
		for (let i = 0; i < data.count; i++) {
			for (let j = 0; j < 12; j++)
				maximumPositionError = Math.max(
					maximumPositionError,
					compareFloat(
						a[i * 16 + j],
						b[i * 16 + j],
						4e-5,
						`${label} state side${side} agent${i} field${j}`
					)
				);
			assert.deepEqual(
				[...ai.subarray(i * 16 + 12, i * 16 + 16)],
				[...bi.subarray(i * 16 + 12, i * 16 + 16)],
				`${label}: exact ID/species/active/generation`
			);
		}
		const am = new Float32Array(actual.metrics[side]),
			bm = new Float32Array(expected.metrics[side]);
		for (let i = 0; i < data.count; i++)
			for (let j = 0; j < packing.METRIC_ORDER.length; j++)
				maximumMetricError = Math.max(
					maximumMetricError,
					compareFloat(
						am[i * METRIC_STRIDE + j],
						bm[i * METRIC_STRIDE + j],
						metricTolerances[j],
						`${label} metrics side${side} agent${i} ${packing.METRIC_ORDER[j]}`,
						circularMetrics.has(j)
					)
				);
	}
	assert.deepEqual(
		new Uint32Array(actual.grid),
		new Uint32Array(expected.grid),
		`${label}: counts/offsets/scatter cursors`
	);
	assert.deepEqual(
		gridMembership(data, actual.grid, actual.indices, actual.particles[data.side]),
		gridMembership(data, expected.grid, expected.indices, expected.particles[data.side]),
		`${label}: neighbor membership independent of atomic scatter order`
	);
	const ah = new Float32Array(actual.history),
		bh = new Float32Array(expected.history),
		current = new Float32Array(actual.particles[data.side]);
	const colorBase = data.count * packing.HISTORY_SAMPLES * 4;
	for (let i = 0; i < ah.length; i++) {
		// Atomic scatter order changes the Float32 sum order. Recorded colors
		// include nonlinear HSL/transfer functions of those tolerated metrics;
		// keep spatial history strict and bound RGB separately to 1/1000 linear.
		const isColor = i >= colorBase;
		const tolerance = isColor ? (i % 4 === 3 ? 0 : 1e-3) : 4e-5;
		compareFloat(ah[i], bh[i], tolerance, `${label} ${isColor ? 'color' : 'trajectory'} word${i}`);
	}
	if (sampled) {
		for (let i = 0; i < data.count; i++) {
			const slot = (i * 64 + data.head) * 4;
			for (let axis = 0; axis < 3; axis++)
				assert.equal(
					ah[slot + axis],
					current[i * 16 + axis],
					'sample records newly integrated current position exactly'
				);
			assert.equal(ah[slot + 3], data.generation, 'history carries correct generation');
		}
	} else if (previousHistory)
		assert.deepEqual(
			ah,
			previousHistory,
			'unsampled/bootstrap operation preserves every history word'
		);
	return { history: ah, maximumPositionError, maximumMetricError };
}

async function replaceBuffers(data, runtime) {
	for (const path of ['reference', 'batched']) {
		const old = data[path];
		const clone = async (buffer) => {
			const bytes = await buffer.read(buffer.options.size);
			const replacement = data.allocate(
				`replacement ${path} ${buffer.options.label}`,
				buffer.options.size + 16
			);
			replacement.write(bytes);
			return replacement;
		};
		const replacement = {};
		for (const key of ['config', 'history', 'grid', 'indices', 'blocks', 'species', 'pairRules'])
			replacement[key] = await clone(old[key]);
		replacement.particles = await Promise.all(old.particles.map(clone));
		replacement.metrics = await Promise.all(old.metrics.map(clone));
		data[path] = replacement;
		for (const buffer of flatBuffers(old)) {
			buffer.destroy();
			data.owned.delete(buffer);
		}
	}
	const before = submissions;
	runtime.rebind(data.batched);
	assert.equal(submissions, before, 'rebind creates bindings without submitting work');
}

try {
	const world = { kind: 'volume', shape: 'box', halfExtents: [12, 8, 11], boundaries: 'reflect' };
	const surface = { kind: 'surface', shape: 'sphere', radius: 8 };
	const cases = [
		['ordinary volume', sceneFor(world, 176), false, false],
		['dense complete volume', sceneFor(world, 145), true, false],
		['ordinary sphere', sceneFor(surface, 160), false, false],
		['dense complete sphere', sceneFor(surface, 145), true, false],
		[
			'periodic partial-edge seams',
			sceneFor(
				{ kind: 'volume', shape: 'box', halfExtents: [5.1, 3.4, 4.7], boundaries: 'periodic' },
				128
			),
			false,
			true
		],
		[
			'one-cell grid',
			sceneFor(
				{ kind: 'volume', shape: 'box', halfExtents: [0.45, 0.4, 0.5], boundaries: 'reflect' },
				35
			),
			false,
			false
		]
	];
	for (const [index, [name, scene, dense, seams]] of cases.entries()) {
		const data = allocateCase(scene, agentsFor(scene, dense, seams), index);
		try {
			const runtime = await createComputeRuntime(countedGpu, shaders, data.batched);
			const startSubmissions = submissions;
			bootstrap(data, runtime);
			let snapshot = await compareSnapshots(data, `${name} bootstrap`);
			let maximumPositionError = snapshot.maximumPositionError,
				maximumMetricError = snapshot.maximumMetricError;
			for (let step = 0; step < 4; step++) {
				const sampled = tick(data, runtime, [0.25, 0.5, 0.125, 0.75][step]);
				snapshot = await compareSnapshots(
					data,
					`${name} tick${step + 1}`,
					sampled,
					snapshot.history
				);
				maximumPositionError = Math.max(maximumPositionError, snapshot.maximumPositionError);
				maximumMetricError = Math.max(maximumMetricError, snapshot.maximumMetricError);
				if (step < 2) {
					const oldMetrics = new Float32Array(
						await data.batched.metrics[data.metricSide].read(data.count * METRIC_BYTES)
					);
					await replaceBuffers(data, runtime);
					bootstrap(data, runtime, 0);
					snapshot = await compareSnapshots(
						data,
						`${name} rebind at particleSide${data.side}`,
						false,
						snapshot.history
					);
					const refreshed = new Float32Array(
						await data.batched.metrics[data.metricSide].read(data.count * METRIC_BYTES)
					);
					for (let i = 0; i < data.count; i++)
						for (const field of [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
							assert.equal(
								refreshed[i * METRIC_STRIDE + field],
								oldMetrics[i * METRIC_STRIDE + field],
								'alpha-zero replacement refresh exactly retains twelve temporal fields'
							);
				}
			}
			assert.equal(
				submissions - startSubmissions,
				7,
				'bootstrap + four ticks + two replacement refreshes submit once each'
			);
			assert.equal(data.head, 1, 'sampling wraps the history head63→0→1');
			assert.equal(data.valid, 3, 'only two actual samples advance valid history');
			assert.equal(
				data.historyTicks,
				0,
				'sampling uses the actual phase rather than raw tick parity'
			);
			if (name === 'one-cell grid') assert.equal(data.grid.count, 1);
			if (name === 'ordinary volume')
				assert.ok(data.grid.count > 256, 'multi-block prefix scan is exercised');
			console.log(
				`PASS ${name}: ${data.count} agents / ${data.grid.count} cells, one-submit snapshots, complete grids, four ticks, both sides rebind, history wrap/phase and filters; max state error=${maximumPositionError.toExponential(2)}, metric error=${maximumMetricError.toExponential(2)}`
			);
		} finally {
			await gpu.gpu.queue.onSubmittedWorkDone();
			for (const buffer of data.owned) buffer.destroy();
		}
	}
	await gpu.settled();
	assert.deepEqual(errors, [], 'no native GPU validation errors');
	console.log('All native compute batching coherence probes passed.');
} finally {
	gpu.dispose();
	if (!previousShaderStage) delete globalThis.GPUShaderStage;
}
