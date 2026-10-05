import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, compute, draw, frame, target } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

// Semantic probes use only the installed public runtime and the production
// shader graph. They isolate forces so an inactive control cannot mask a rule.
const require = createRequire(import.meta.url);
const packagePath = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [packagePath] })).href
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

const gridSource = (await resolveShader({ entry: resolve('src/lib/gpu/shaders/grid.wgsl') })).wgsl;
const simulationSource = (
	await resolveShader({ entry: resolve('src/lib/gpu/shaders/simulate.wgsl') })
).wgsl;
const measurementSource = (
	await resolveShader({ entry: resolve('src/lib/gpu/shaders/metrics.wgsl') })
).wgsl;
const bodySource = (await resolveShader({ entry: resolve('src/lib/gpu/shaders/boids.wgsl') })).wgsl;
const trailSource = (await resolveShader({ entry: resolve('src/lib/gpu/shaders/trails.wgsl') }))
	.wgsl;
const gpu = await init({
	requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxStorageBuffersInVertexStage: 5 }
});
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const entries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const indexPasses = Object.fromEntries(
	entries.map((entry) => [entry, compute(gpu, gridSource, { entry })])
);
const simulation = compute(gpu, simulationSource, { entry: 'simulate' });
const measurement = compute(gpu, measurementSource, { entry: 'measure' });
const linear = {
	points: [
		[0, 0],
		[1, 1]
	]
};
const inverted = {
	points: [
		[0, 1],
		[1, 0]
	]
};
const zero = {
	points: [
		[0, 0],
		[1, 0]
	]
};

function sceneFor(kind) {
	const scene = model.createDefaultScene();
	const source = structuredClone(scene.species[0]);
	const target = structuredClone(scene.species[0]);
	source.key = 'observer';
	target.key = 'neighbor';
	source.name = 'Observer';
	target.name = 'Neighbor';
	for (const species of [source, target]) {
		species.population = 1;
		species.speed = 6;
		species.cruiseSpeed = 0;
		species.force = 2;
		species.perception = 12;
		species.size = 0.1;
		species.alignment = 0;
		species.cohesion = 0;
		species.separation = 0;
		species.rebels.fraction = 0;
		species.metricRules = [];
		species.cursor.response = 'ignore';
		species.cursor.vortex = 0;
	}
	scene.species = [source, target];
	scene.speciesRules = [];
	scene.world =
		kind === 'volume'
			? { kind: 'volume', shape: 'box', halfExtents: [30, 30, 30], boundaries: 'reflect' }
			: { kind: 'surface', shape: 'sphere', radius: 24 };
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.dynamics.orbitAxis = [0, 1, 0];
	scene.forces.enabled = false;
	scene.obstacles = [];
	return scene;
}
function pair(behavior, strength = 1, to = 'neighbor') {
	return { id: `rule-${behavior}-${to}`, from: 'observer', to, behavior, strength, radius: 12 };
}
function agentsFor(scene, distance = 3) {
	if (scene.world.kind === 'volume')
		return [
			{ id: 1, birth: 1, speciesKey: 'observer', position: [0, 0, 0], velocity: [0, 0, 0] },
			{ id: 2, birth: 2, speciesKey: 'neighbor', position: [distance, 0, 0], velocity: [0, 0, 2] }
		];
	const radius = scene.world.radius;
	return [
		{ id: 1, birth: 1, speciesKey: 'observer', position: [radius, 0, 0], velocity: [0, 0, 0] },
		{
			id: 2,
			birth: 2,
			speciesKey: 'neighbor',
			position: [radius * Math.cos(distance / radius), 0, radius * Math.sin(distance / radius)],
			velocity: [0, 2, 0]
		}
	];
}
async function run(
	scene,
	{
		distance = 3,
		selfMetric = 1,
		neighborMetric = 3,
		metricId = 0,
		sameSpecies = false,
		resting = false,
		simulationTime,
		tick = 1,
		initialAgents,
		steps = 1
	} = {}
) {
	const agents = initialAgents ? structuredClone(initialAgents) : agentsFor(scene, distance);
	if (sameSpecies) agents[1].speciesKey = 'observer';
	if (resting) {
		agents[0].velocity = [0, 0, 0];
		agents[1].velocity = [0, 0, 0];
	}
	const g = packing.gridDefinition(scene);
	const owned = [];
	const allocate = (label, size) => {
		const buffer = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(buffer);
		return buffer;
	};
	const config = allocate('semantic config', 16384);
	const current = allocate('semantic current', 128);
	const next = allocate('semantic next', 128);
	const grid = allocate('complete semantic grid', g.count * 12);
	const indices = allocate('complete semantic indices', 8);
	const blocks = allocate('semantic block prefix', Math.ceil(g.count / 256) * 4);
	const metrics = allocate('immutable semantic metrics', 2 * METRIC_BYTES);
	const species = allocate('semantic species', 2 * 64 * 16);
	const pairRules = allocate('semantic directed rules', 4 * 16);
	try {
		const snapshot = new Float32Array(2 * METRIC_STRIDE);
		snapshot[metricId] = selfMetric;
		snapshot[METRIC_STRIDE + metricId] = neighborMetric;
		current.write(packing.packParticles(agents, scene, 1));
		species.write(packing.packSpecies(scene));
		pairRules.write(packing.packPairRules(scene));
		metrics.write(snapshot);
		let input = current,
			output = next;
		for (let step = 0; step < steps; step++) {
			config.write(
				packing.packConfig(scene, {
					population: 2,
					tick: tick + step,
					historyHead: 0,
					validHistory: 1,
					smoothingAlpha: 1,
					simulationTime:
						simulationTime === undefined
							? undefined
							: simulationTime + step * scene.dynamics.fixedDt
				})
			);
			buildIndex({ config, particles: input, grid, indices, blocks }, 2, g.count);
			simulation.set({
				config,
				current: input,
				next: output,
				grid,
				indices,
				metrics,
				species,
				pairRules
			});
			simulation.dispatch(1);
			[input, output] = [output, input];
		}
		const bytes = await input.read(128);
		const states = packing.unpackParticles(bytes, scene, 2);
		const state = states[0];
		assert.ok(
			new Float32Array(bytes).subarray(0, 12).every(Number.isFinite),
			'all contact state values are finite'
		);
		const contact = {
			separation: model.magnitude(
				model.worldDisplacement(scene.world, state.position, states[1].position)
			),
			travel: model.magnitude(
				model.worldDisplacement(scene.world, agents[0].position, state.position)
			),
			acceleration:
				model.magnitude(
					model.subtract(state.velocity, [...new Float32Array(bytes).subarray(8, 11)])
				) / scene.dynamics.fixedDt
		};
		assert.deepEqual(
			new Float32Array(await metrics.read(2 * METRIC_BYTES)),
			snapshot,
			'simulation reads an immutable metric snapshot'
		);
		let velocity = state.velocity;
		if (scene.world.kind === 'surface') {
			assert.ok(
				Math.abs(model.dot(state.position, velocity)) < 2e-5,
				'forced surface velocity is tangent'
			);
			assert.ok(
				Math.abs(model.magnitude(state.position) - scene.world.radius) < 2e-5,
				'forced surface position stays on radius'
			);
			velocity = model.sphereTransport(velocity, state.position, agents[0].position);
			// Observer tangent coordinates: displacement +Z, target heading +Y.
			return {
				toward: velocity[2],
				heading: velocity[1],
				transverse: velocity[0],
				magnitude: model.magnitude(velocity),
				...contact
			};
		}
		return {
			toward: velocity[0],
			heading: velocity[2],
			transverse: velocity[1],
			magnitude: model.magnitude(velocity),
			...contact
		};
	} finally {
		for (const buffer of owned) buffer.destroy();
	}
}
function positive(value, name) {
	assert.ok(value > 1e-4, `${name} must be positive: ${value}`);
}
function negative(value, name) {
	assert.ok(value < -1e-4, `${name} must be negative: ${value}`);
}
function stationary(result, name) {
	assert.ok(result.magnitude < 1e-7, `${name} must exert zero force: ${result.magnitude}`);
}
function close(actual, expected, name, tolerance = 2e-4) {
	assert.ok(Math.abs(actual - expected) < tolerance, `${name}: ${actual} vs ${expected}`);
}
function metricRule(role, curve = linear, metric = 'speed', range = [0, 4]) {
	return {
		id: `metric-${role}`,
		metric,
		role,
		range,
		curve,
		behavior: 'flee',
		// Keep mapping probes below the shared cap, including urgent Flee's
		// inherited separation falloff, so ratios isolate metric activation.
		strength: 0.5,
		radius: 12
	};
}

const metricTolerance = {
	speed: 3e-5,
	turnRate: 8e-4,
	acceleration: 3e-3,
	neighborCount: 0,
	density: 8e-5,
	anisotropy: 4e-4,
	polarization: 2e-5,
	radialFlow: 3e-5,
	headingAzimuth: 2e-5,
	centerDistance: 4e-5,
	centerBearing: 3e-5,
	flowOrbit: 3e-5,
	centerOrbitAngle: 5e-5,
	centerRadialSpeed: 8e-5,
	speedContrast: 4e-5
};
const circularFields = new Set([
	'headingAzimuth',
	'centerBearing',
	'flowOrbit',
	'centerOrbitAngle'
]);
function buildIndex(resources, count, cells) {
	for (const pass of Object.values(indexPasses)) pass.set(resources);
	indexPasses.clear_grid.dispatch(Math.ceil(cells / 256));
	indexPasses.count_particles.dispatch(Math.ceil(count / 256));
	indexPasses.prefix_cells.dispatch(Math.ceil(cells / 256));
	indexPasses.prefix_blocks.dispatch(1);
	indexPasses.finish_prefix.dispatch(Math.ceil(cells / 256));
	indexPasses.scatter_particles.dispatch(Math.ceil(count / 256));
}
function previousStates(scene, agents) {
	return agents.map((agent, i) => {
		const angle = 0.06 + (i % 5) * 0.04;
		let rotated;
		let position;
		if (scene.world.kind === 'surface') {
			const normal = model.normalize(agent.position);
			rotated = model.add(
				model.scale(agent.velocity, Math.cos(angle)),
				model.scale(model.cross(normal, agent.velocity), Math.sin(angle))
			);
			position = model.sphereExp(
				agent.position,
				model.scale(agent.velocity, -scene.dynamics.fixedDt),
				scene.world.radius
			);
			rotated = model.sphereTransport(rotated, agent.position, position);
		} else {
			const [x, y, z] = agent.velocity;
			rotated = [
				x * Math.cos(angle) - z * Math.sin(angle),
				y + 0.1,
				x * Math.sin(angle) + z * Math.cos(angle)
			];
			position = model.subtract(
				agent.position,
				model.scale(agent.velocity, scene.dynamics.fixedDt)
			);
		}
		return {
			...agent,
			position,
			velocity: i % 11 === 0 ? [0, 0, 0] : model.scale(rotated, 0.83 + (i % 3) * 0.05)
		};
	});
}
async function compareMeasurements(
	name,
	scene,
	agents,
	anchors = [],
	{ alpha = 1, priorMetrics } = {}
) {
	const owned = [];
	const allocate = (label, size) => {
		const buffer = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(buffer);
		return buffer;
	};
	const count = agents.length;
	const g = packing.gridDefinition(scene);
	const config = allocate('measurement config', 16384);
	const particles = allocate('measured particles', count * 64);
	const grid = allocate('measured complete grid', g.count * 12);
	const indices = allocate('measured complete indices', count * 4);
	const blocks = allocate('measured block prefix', Math.ceil(g.count / 256) * 4);
	const previousMetrics = allocate('zero prior measurements', count * METRIC_BYTES);
	const nextMetrics = allocate('result measurements', count * METRIC_BYTES);
	const species = allocate('measurement species', scene.species.length * 64 * 16);
	try {
		// The oracle sees exactly the f32 inputs uploaded to the device, avoiding
		// disagreement caused solely by comparing original doubles to packed data.
		const bytes = packing.packParticles(agents, scene, 1);
		const packed = packing.unpackParticles(bytes, scene, count);
		const prior = packing.unpackParticles(
			packing.packParticles(previousStates(scene, agents), scene, 1),
			scene,
			count
		);
		const floats = new Float32Array(bytes);
		packed.forEach((agent, i) => {
			const velocity =
				scene.world.kind === 'surface'
					? model.sphereTransport(prior[i].velocity, prior[i].position, agent.position)
					: prior[i].velocity;
			floats.set(velocity, i * 16 + 8);
		});
		particles.write(bytes);
		species.write(packing.packSpecies(scene));
		if (priorMetrics) previousMetrics.write(priorMetrics);
		config.write(
			packing.packConfig(scene, {
				population: count,
				tick: 1,
				historyHead: 0,
				validHistory: 1,
				smoothingAlpha: alpha
			})
		);
		buildIndex({ config, particles, grid, indices, blocks }, count, g.count);
		measurement.set({ config, particles, previousMetrics, nextMetrics, grid, indices, species });
		measurement.dispatch(Math.ceil(count / 128));
		const measured = new Float32Array(await nextMetrics.read(count * METRIC_BYTES));
		const expected = model.measureAllPairs(scene, packed, prior);
		const maximumErrors = Object.fromEntries(packing.METRIC_ORDER.map((field) => [field, 0]));
		for (let i = 0; i < count; i++) {
			for (let j = 0; j < packing.METRIC_ORDER.length; j++) {
				const field = packing.METRIC_ORDER[j];
				const actual = measured[i * METRIC_STRIDE + j];
				const retained =
					priorMetrics &&
					alpha === 0 &&
					priorMetrics[i * METRIC_STRIDE] >= 0 &&
					!['speed', 'neighborCount', 'density'].includes(field);
				const reference = retained ? priorMetrics[i * METRIC_STRIDE + j] : expected[i][field];
				assert.ok(Number.isFinite(actual), `${name}: finite ${field} for agent ${i}`);
				if (retained)
					assert.equal(
						actual,
						reference,
						`${name}: alpha zero exactly preserves ${field} for surviving agent ${i}`
					);
				let error = Math.abs(actual - reference);
				if (circularFields.has(field)) error = Math.min(error, 1 - error);
				maximumErrors[field] = Math.max(maximumErrors[field], error);
				assert.ok(
					error <= metricTolerance[field],
					`${name}: ${field} agent ${i}, GPU=${actual}, CPU=${reference}, error=${error}, tolerance=${metricTolerance[field]}`
				);
			}
		}
		for (const [index, anisotropy] of anchors) {
			close(expected[index].anisotropy, anisotropy, `${name}: analytic reference geometry`, 1e-6);
			close(
				measured[index * METRIC_STRIDE + 5],
				anisotropy,
				`${name}: GPU analytic geometry`,
				metricTolerance.anisotropy
			);
		}
		console.log(
			`PASS ${name}: all 15 fields for ${count} agents match all-pairs CPU reference; max anisotropy error=${maximumErrors.anisotropy.toExponential(2)}, turn=${maximumErrors.turnRate.toExponential(2)}, acceleration=${maximumErrors.acceleration.toExponential(2)}`
		);
	} finally {
		for (const buffer of owned) buffer.destroy();
	}
}
function structuredVolume() {
	const scene = sceneFor('volume');
	scene.world.halfExtents = [16, 7, 7];
	scene.species.forEach((s) => {
		s.perception = 2.5;
	});
	const agents = [];
	const append = (position) => {
		const id = agents.length + 1;
		agents.push({
			id,
			birth: id,
			speciesKey: id % 2 ? 'observer' : 'neighbor',
			position,
			velocity: [1 + id * 0.01, Math.sin(id) * 0.2, Math.cos(id) * 0.3]
		});
	};
	const anchors = [];
	anchors.push([agents.length, 0]);
	append([-8, 0, 0]);
	for (const radius of [1, 1.5])
		for (const direction of [
			[1, 0, 0],
			[-1, 0, 0],
			[0, 1, 0],
			[0, -1, 0],
			[0, 0, 1],
			[0, 0, -1]
		])
			append(model.add([-8, 0, 0], model.scale(direction, radius)));
	anchors.push([agents.length, 0.25]);
	append([0, 0, 0]);
	for (let i = 0; i < 8; i++)
		append([1.5 * Math.cos((i * Math.PI) / 4), 0, 1.5 * Math.sin((i * Math.PI) / 4)]);
	anchors.push([agents.length, 1]);
	append([8, 0, 0]);
	for (const offset of [-1.5, -1, -0.5, 0.5, 1, 1.5]) append([8 + offset, 0, 0]);
	return { scene, agents, anchors };
}
function structuredSurface() {
	const scene = sceneFor('surface');
	scene.world.radius = 12;
	scene.species.forEach((s) => {
		s.perception = 2.5;
	});
	const agents = [];
	const append = (position) => {
		const id = agents.length + 1;
		const frame = model.localFrame(scene.world, position);
		const velocity = model.add(
			model.scale(frame[0], 1 + id * 0.02),
			model.scale(frame[1], 0.2 + Math.sin(id) * 0.1)
		);
		agents.push({
			id,
			birth: id,
			speciesKey: id % 2 ? 'observer' : 'neighbor',
			position,
			velocity
		});
	};
	const anchors = [];
	for (const center of [
		[0, 12, 0],
		[12, 0, 0],
		[0, -12, 0]
	]) {
		const frame = model.localFrame(scene.world, center);
		anchors.push([agents.length, 0]);
		append(center);
		for (let i = 0; i < 8; i++) {
			const angle = (i * Math.PI) / 4;
			append(
				model.sphereExp(
					center,
					model.add(
						model.scale(frame[0], 1.2 * Math.cos(angle)),
						model.scale(frame[1], 1.2 * Math.sin(angle))
					),
					12
				)
			);
		}
	}
	return { scene, agents, anchors };
}

function randomMeasurements(kind, periodic = false) {
	const scene = sceneFor(kind);
	scene.seed = 0x6e39bc81;
	scene.species.forEach((species, i) => {
		species.population = 73 + i * 11;
		species.perception = periodic ? 2.6 : 4;
	});
	if (kind === 'surface') scene.world.radius = 9;
	else
		scene.world = {
			kind: 'volume',
			shape: 'box',
			halfExtents: periodic ? [5.1, 3.4, 4.7] : [7, 6, 8],
			boundaries: periodic ? 'periodic' : 'reflect'
		};
	return { scene, agents: model.initializePopulation(scene).agents };
}

async function verifyIntegerNoise(kind) {
	const scene = sceneFor(kind);
	scene.dynamics.noise = 1;
	scene.seed = 0x1234abcd;
	const highSeed = structuredClone(scene);
	highSeed.seed = 0xb634abcd;
	assert.equal(
		scene.seed & 0xffffff,
		highSeed.seed & 0xffffff,
		'seed probe shares all low 24 bits'
	);
	const config = packing.packConfig(highSeed, {
		population: 2,
		tick: 0x1000001,
		historyHead: 0,
		validHistory: 1
	});
	const words = new Uint32Array(config.buffer);
	assert.equal(words[56], 0x1000001, 'packed tick survives beyond f32 integer precision');
	assert.equal(words[57], highSeed.seed, 'packed seed retains high byte');
	const original = await run(scene, { tick: 0x1000000 });
	const changedSeed = await run(highSeed, { tick: 0x1000000 });
	const changedTick = await run(scene, { tick: 0x1000001 });
	const vector = (result) => [result.toward, result.heading, result.transverse];
	const difference = (a, b) => model.magnitude(model.subtract(vector(a), vector(b)));
	assert.ok(
		difference(original, changedSeed) > 1e-4,
		`${kind}: high seed byte changes actual GPU noise`
	);
	assert.ok(
		difference(original, changedTick) > 1e-4,
		`${kind}: adjacent ticks beyond 2^24 change actual GPU noise`
	);
	const same = await run(scene, { tick: 0x1000000 });
	close(difference(original, same), 0, `${kind}: full-width seeded noise repeats exactly`, 1e-7);
	// These integer words look like NaNs as f32. Storage must preserve the words
	// because the shader bitcasts them before using any floating-point arithmetic.
	const nanSeed = structuredClone(scene);
	nanSeed.seed = 0x7fc00001;
	const changedNanSeed = structuredClone(nanSeed);
	changedNanSeed.seed = 0x7fc00002;
	assert.ok(
		difference(await run(nanSeed), await run(changedNanSeed)) > 1e-4,
		`${kind}: raw NaN-shaped seed words remain distinct`
	);
	console.log(
		`PASS ${kind}: full 32-bit seeds, raw word preservation and adjacent ticks beyond 2^24`
	);
}

async function verifyCruiseAndQueries(kind) {
	const scene = sceneFor(kind);
	scene.species[0].cruiseSpeed = 0.6;
	scene.species[0].force = 1.2;
	const launched = await run(scene, { resting: true });
	close(
		launched.magnitude,
		scene.species[0].force * scene.dynamics.fixedDt,
		`${kind}: stationary cruise launch uses bounded propulsion`,
		2e-6
	);
	assert.ok(
		launched.acceleration <= scene.species[0].force + 2e-4,
		`${kind}: cruise launch respects the total force budget`
	);
	const repeat = await run(scene, { resting: true });
	for (const component of ['toward', 'heading', 'transverse'])
		close(
			repeat[component],
			launched[component],
			`${kind}: stable seeded launch heading ${component}`,
			1e-7
		);
	const noForce = structuredClone(scene);
	noForce.species[0].force = 0;
	stationary(
		await run(noForce, { resting: true }),
		`${kind}: zero force cannot launch toward cruise`
	);
	const stopped = structuredClone(scene);
	stopped.species[0].cruiseSpeed = 0;
	stationary(
		await run(stopped, { resting: true }),
		`${kind}: zero cruise preserves stationary semantics`
	);
	const steps =
		Math.ceil(scene.species[0].cruiseSpeed / (scene.species[0].force * scene.dynamics.fixedDt)) + 8;
	const settled = await run(scene, { resting: true, steps });
	close(
		settled.magnitude,
		scene.species[0].cruiseSpeed,
		`${kind}: active cruising reaches and retains its target`,
		3e-5
	);
	assert.ok(
		settled.acceleration < 1e-3,
		`${kind}: settled cruising does not add artificial acceleration`
	);
	const turned = structuredClone(scene);
	turned.speciesRules = [pair('orbit')];
	const moving = agentsFor(turned);
	moving[0].velocity = kind === 'volume' ? [-0.1, 0, 0] : [0, 0, -0.1];
	moving[1].velocity = [0, 0, 0];
	const steering = await run(turned, { initialAgents: moving });
	assert.ok(
		Math.abs(steering.heading) > 1e-4,
		`${kind}: steering changes the candidate heading during cruise propulsion`
	);
	assert.ok(
		steering.magnitude > 0.1,
		`${kind}: cruise and turning both contribute within the shared budget`
	);
	assert.ok(
		steering.acceleration <= turned.species[0].force + 2e-4,
		`${kind}: turning plus cruise share one total force budget`
	);
	assert.ok(
		steering.magnitude <= turned.species[0].speed + 2e-5,
		`${kind}: cruise preserves max speed`
	);
	const ranged = sceneFor(kind);
	ranged.species.forEach((species) => {
		species.perception = 0.5;
	});
	ranged.speciesRules = [pair('flee')];
	negative((await run(ranged)).toward, `${kind}: active directed range extends beyond perception`);
	ranged.speciesRules = [];
	ranged.species[0].metricRules = [metricRule('neighbor')];
	negative((await run(ranged)).toward, `${kind}: active metric range extends beyond perception`);
	ranged.species[0].metricRules = [];
	ranged.species[1].size = 2;
	const contact = await run(ranged, { distance: 1.5, resting: true });
	assert.ok(
		contact.separation > 1.5 + 1e-4,
		`${kind}: complete source range retains cross-species positional contacts when collision force is zero`
	);
	ranged.dynamics.collision = 1;
	negative(
		(await run(ranged, { distance: 2.3, resting: true })).toward,
		`${kind}: complete source range retains soft collisions outside positional contact`
	);
	console.log(
		`PASS ${kind}: bounded cruise launch/settling/steering, zero-force semantics, and complete per-source directed/metric/contact ranges`
	);
}

async function verifyColorChannels() {
	const scene = sceneFor('volume');
	scene.species = [scene.species[0]];
	scene.species[0].size = 0.8;
	scene.visual.palette = 'rainbow';
	const owned = [];
	const allocate = (label, size) => {
		const buffer = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(buffer);
		return buffer;
	};
	const config = allocate('color config', 16384);
	const particles = allocate('color particle', 64);
	const metrics = allocate('color sources', METRIC_BYTES);
	const species = allocate('color species', 64 * 16);
	const output = target(gpu, { size: [128, 128], format: 'rgba8unorm', depth: true });
	const camera = perspectiveCamera({
		fov: 42,
		aspect: 1,
		position: [0, 2, 7],
		target: [0, 0, 0],
		near: 0.1,
		far: 100
	});
	const body = draw(gpu, {
		shader: bodySource,
		vertices: 36,
		depth: { write: true },
		set: {
			config,
			particles,
			metrics,
			species,
			camera: {
				viewProjection: camera.viewProjection,
				position: [...camera.worldPosition, 1],
				right: [1, 0, 0, 0],
				up: [0, 1, 0, 0]
			}
		}
	});
	try {
		particles.write(
			packing.packParticles(
				[{ id: 1, birth: 1, speciesKey: 'observer', position: [0, 0, 0], velocity: [0, 0, 1] }],
				scene,
				1
			)
		);
		const mapped = structuredClone(scene);
		mapped.species[0].visual.hsl = [0.05, 0.3, 0.65];
		const map = (source, range, strength = 1) => ({
			enabled: true,
			source,
			range,
			strength,
			curve: linear
		});
		mapped.species[0].visual.hue = map('speed', [0, 4]);
		mapped.species[0].visual.saturation = map('anisotropy', [0, 1]);
		mapped.species[0].visual.lightness = map('polarization', [0, 1]);
		const sources = new Float32Array(METRIC_STRIDE);
		sources[0] = 3;
		sources[5] = 0.8;
		sources[6] = 0.25;
		const render = async (definition, values) => {
			config.write(
				packing.packConfig(definition, { population: 1, tick: 1, historyHead: 0, validHistory: 1 })
			);
			species.write(packing.packSpecies(definition));
			metrics.write(values);
			await frame(gpu, (f) =>
				f.pass({ target: output, clear: [0, 0, 0, 0], clearDepth: 1 }, (p) =>
					p.draw(body, { instances: 1 })
				)
			).done;
			return output.color.read({ mipLevel: 0, region: 'all' });
		};
		const compare = (actual, expected, message) => {
			assert.equal(actual.length, expected.length);
			let opaque = 0,
				maximum = 0;
			for (let i = 0; i < actual.length; i++) {
				maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
				if (i % 4 === 3 && actual[i] > 0) opaque++;
			}
			assert.ok(opaque > 100, `${message}: visible body geometry`);
			assert.ok(maximum <= 1, `${message}: per-pixel color difference ${maximum}`);
		};
		const constant = (hsl) => {
			const definition = structuredClone(scene);
			definition.species[0].visual.hsl = hsl;
			for (const channel of ['hue', 'saturation', 'lightness'])
				definition.species[0].visual[channel].enabled = false;
			return definition;
		};
		const independent = await render(mapped, sources);
		compare(
			independent,
			await render(constant([0.75, 0.8, 0.25]), sources),
			'Independent speed/anisotropy/polarization H/S/L maps'
		);
		const irrelevant = sources.slice();
		irrelevant[1] = 200;
		irrelevant[3] = 999;
		irrelevant[11] = 0.1;
		compare(independent, await render(mapped, irrelevant), 'Unmapped metrics do not alter color');
		const changedSaturation = sources.slice();
		changedSaturation[5] = 0.2;
		compare(
			await render(mapped, changedSaturation),
			await render(constant([0.75, 0.2, 0.25]), changedSaturation),
			'Saturation source changes independently'
		);
		const mixed = structuredClone(mapped);
		mixed.species[0].visual.hue.strength = 0.5;
		mixed.species[0].visual.saturation.strength = 0.25;
		mixed.species[0].visual.lightness.strength = 0.75;
		compare(
			await render(mixed, sources),
			await render(constant([0.4, 0.425, 0.35]), sources),
			'Independent strengths and continuous scalar hue interpolation'
		);
		console.log(
			'PASS native color render: independent H/S/L sources, unrelated metric isolation, saturation changes, strengths and scalar hue blend'
		);
	} finally {
		for (const buffer of owned) buffer.destroy();
	}
}

async function verifyRetainedTrails() {
	const owned = [];
	const allocate = (label, size) => {
		const buffer = gpu.device.createBuffer({
			label,
			size,
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(buffer);
		return buffer;
	};
	const config = allocate('trail retention config', 16384);
	const particles = allocate('trail retention particle', 64);
	const metrics = allocate('trail retention metrics', METRIC_BYTES);
	const species = allocate('trail retention species', 64 * 16);
	const history = allocate(
		'trail retention history',
		packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES
	);
	const output = target(gpu, { size: [192, 128], format: 'rgba8unorm', depth: true });
	const camera = perspectiveCamera({
		fov: 45,
		aspect: 1.5,
		position: [0, 0, 8],
		target: [0, 0, 0],
		near: 0.1,
		far: 100
	});
	const trails = draw(gpu, {
		shader: trailSource,
		vertices: 18,
		depth: { write: false, compare: 'less-equal' },
		blend: 'premultiplied',
		set: {
			config,
			particles,
			metrics,
			species,
			history,
			camera: {
				viewProjection: camera.viewProjection,
				position: [...camera.worldPosition, 1],
				right: [1, 0, 0, 0],
				up: [0, 1, 0, 0]
			}
		}
	});
	const generation = 21;
	const scene = sceneFor('volume');
	scene.species = [scene.species[0]];
	scene.world.halfExtents = [4, 3, 4];
	scene.species[0].speed = 50;
	scene.species[0].size = 0.3;
	scene.species[0].perception = 2;
	scene.species[0].trail = { length: 4, width: 0.24, opacity: 1 };
	scene.species[0].visual.hsl = [0.12, 0.8, 0.6];
	for (const channel of ['hue', 'saturation', 'lightness'])
		scene.species[0].visual[channel].enabled = false;
	const render = async (
		definition,
		position,
		samples,
		{ vertices = 18, sampleGeneration = generation } = {}
	) => {
		particles.write(
			packing.packParticles(
				[{ id: 1, birth: 1, speciesKey: 'observer', position, velocity: [0, 0, 0] }],
				definition,
				generation
			)
		);
		species.write(packing.packSpecies(definition));
		const records = new Float32Array(64 * 4);
		for (let slot = 0; slot < 64; slot++) records.set([...samples[0], sampleGeneration], slot * 4);
		samples.forEach((sample, age) =>
			records.set([...sample, sampleGeneration], ((63 - age + 64) % 64) * 4)
		);
		history.write(records);
		config.write(
			packing.packConfig(definition, {
				population: 1,
				tick: 7,
				historyHead: 63,
				validHistory: samples.length,
				historyElapsed: 0.4,
				runGeneration: generation,
				sampleHistory: false
			})
		);
		await frame(gpu, (f) =>
			f.pass({ target: output, clear: [0, 0, 0, 0], clearDepth: 1 }, (pass) =>
				pass.draw(trails, { instances: 1, vertices })
			)
		).done;
		return output.color.read({ mipLevel: 0, region: 'all' });
	};
	const visible = (pixels) => {
		let count = 0;
		for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
		return count;
	};
	const projected = (point) => {
		const m = camera.viewProjection;
		const clip = [0, 1, 2, 3].map(
			(row) => m[row] * point[0] + m[4 + row] * point[1] + m[8 + row] * point[2] + m[12 + row]
		);
		return [((clip[0] / clip[3]) * 0.5 + 0.5) * 192, (0.5 - (clip[1] / clip[3]) * 0.5) * 128];
	};
	const nearPixel = (pixels, point) => {
		const [x, y] = projected(point).map(Math.round);
		for (let dy = -2; dy <= 2; dy++)
			for (let dx = -2; dx <= 2; dx++) {
				const px = x + dx,
					py = y + dy;
				if (px >= 0 && px < 192 && py >= 0 && py < 128 && pixels[(py * 192 + px) * 4 + 3] > 0)
					return true;
			}
		return false;
	};
	try {
		const position = [1.4, 0, 0],
			samples = [
				[0, 0, 0],
				[-1, 0, 0],
				[-2, 0, 0]
			];
		const retained = await render(scene, position, samples);
		assert.ok(visible(retained) > 50, 'retained world trajectory is visibly rendered');
		const slower = structuredClone(scene);
		slower.species[0].speed = 0.05;
		slower.species[0].size = 0.001;
		assert.deepEqual(
			await render(slower, position, samples),
			retained,
			'paused max-speed/body-size edit preserves every pixel of the retained volume path'
		);
		const head = await render(scene, position, samples, { vertices: 6 });
		assert.ok(
			nearPixel(head, [0.7, 0, 0]),
			'first segment bridges actual particle position to newest history'
		);
		assert.ok(
			nearPixel(head, [1.37, 0, 0]),
			'head segment reaches the current particle rather than lagging at the newest sample'
		);
		assert.ok(
			!nearPixel(head, [-0.6, 0, 0]),
			'isolated head segment does not substitute an older history pair'
		);
		const periodic = structuredClone(scene);
		periodic.world.boundaries = 'periodic';
		const seamHistory = [
			[3.8, 0, 0],
			[3.6, 0, 0]
		];
		const seam = await render(periodic, [-3.8, 0, 0], seamHistory, { vertices: 6 });
		assert.equal(visible(seam), 0, 'periodic wrap does not draw a chord across the box');
		assert.ok(
			visible(await render(scene, [-3.8, 0, 0], seamHistory, { vertices: 6 })) > 100,
			'same long finite segment remains valid in a reflecting world'
		);
		assert.equal(
			visible(await render(scene, [0, 0, 0], [[0, 0, 0]], { vertices: 6 })),
			0,
			'zero-length trajectory is skipped'
		);
		assert.equal(
			visible(
				await render(scene, position, samples, { vertices: 6, sampleGeneration: generation - 1 })
			),
			0,
			'stale generation is skipped'
		);
		assert.equal(
			visible(await render(scene, position, [[NaN, 0, 0]], { vertices: 6 })),
			0,
			'nonfinite history is skipped before conversion/interpolation'
		);
		const sphere = structuredClone(scene);
		sphere.world = { kind: 'surface', shape: 'sphere', radius: 4 };
		const center = [0, 0, 4];
		const spherePosition = model.sphereExp(center, [1.4, 0, 0], 4);
		const sphereSamples = [
			center,
			model.sphereExp(center, [-1, 0, 0], 4),
			model.sphereExp(center, [-2, 0, 0], 4)
		];
		const surfaceRetained = await render(sphere, spherePosition, sphereSamples);
		assert.ok(
			visible(surfaceRetained) > 50,
			'retained lifted spherical trajectory is visibly rendered'
		);
		const slowerSphere = structuredClone(sphere);
		slowerSphere.species[0].speed = 0.05;
		assert.deepEqual(
			await render(slowerSphere, spherePosition, sphereSamples),
			surfaceRetained,
			'paused max-speed edit preserves every pixel of the retained spherical path'
		);
		assert.equal(
			visible(await render(sphere, [0, 0, -4], [center], { vertices: 6 })),
			0,
			'antipodal spherical history does not choose an arbitrary interpolation arc'
		);
		console.log(
			'PASS production trail render: retained volume/sphere paths survive paused speed edits; size retention, exact head attachment, periodic seam, finite/zero/generation and antipodal guards'
		);
	} finally {
		for (const buffer of owned) buffer.destroy();
	}
}

try {
	for (const kind of ['volume', 'surface']) {
		const results = {};
		for (const behavior of model.BEHAVIORS) {
			const scene = sceneFor(kind);
			scene.speciesRules = [pair(behavior)];
			results[behavior] = await run(scene);
		}
		stationary(results.ignore, `${kind} Ignore`);
		negative(results.flee.toward, `${kind} Flee away`);
		positive(results.chase.toward, `${kind} Chase approach`);
		positive(results.chase.heading, `${kind} Chase lead`);
		positive(results.cohere.toward, `${kind} Cohere approach`);
		positive(results.align.heading, `${kind} Align target heading`);
		close(results.align.toward, 0, `${kind} Align without attraction`);
		negative(results.orbit.heading, `${kind} Orbit handedness`);
		close(results.orbit.toward, 0, `${kind} Orbit tangent to separation`);
		positive(results.follow.toward, `${kind} Follow approach`);
		negative(results.follow.heading, `${kind} Follow behind target`);
		negative(results.guard.toward, `${kind} Guard keeps inner clearance`);
		negative(results.disperse.toward, `${kind} Disperse away`);
		positive(results.mob.toward, `${kind} Mob converges`);
		assert.ok(Math.abs(results.mob.heading) > 1e-4, `${kind} Mob has orbit component`);
		negative(results.mirror.heading, `${kind} Mirror opposite heading`);
		close(results.mirror.toward, 0, `${kind} Mirror without attraction`);
		positive(results.spiral.toward, `${kind} Spiral converges`);
		assert.ok(
			Math.abs(results.spiral.heading) > results.spiral.toward,
			`${kind} Spiral has dominant orbit component`
		);
		const guard = sceneFor(kind);
		guard.speciesRules = [pair('guard')];
		stationary(await run(guard, { distance: 6 }), `${kind} Guard equilibrium`);
		positive((await run(guard, { distance: 9 })).toward, `${kind} Guard outer approach`);
		console.log(
			`PASS ${kind}: all 12 directed behavior semantics and Guard inner/equilibrium/outer regions`
		);

		const roleResults = {};
		for (const role of ['neighbor', 'self', 'difference']) {
			const scene = sceneFor(kind);
			scene.species[0].metricRules = [metricRule(role)];
			roleResults[role] = await run(scene);
			negative(roleResults[role].toward, `${kind} ${role} metric influence`);
		}
		close(
			roleResults.neighbor.magnitude / roleResults.self.magnitude,
			3,
			`${kind} Neighbor/Self source ratio`
		);
		close(
			roleResults.difference.magnitude / roleResults.self.magnitude,
			2,
			`${kind} absolute Difference source ratio`
		);
		const reverse = sceneFor(kind);
		reverse.species[0].metricRules = [metricRule('neighbor', inverted)];
		close(
			(await run(reverse)).magnitude,
			roleResults.self.magnitude,
			`${kind} inverse curve maps .75 to .25`
		);
		const muted = sceneFor(kind);
		muted.species[0].metricRules = [metricRule('neighbor', zero)];
		stationary(await run(muted), `${kind} zero curve`);
		const circular = sceneFor(kind);
		circular.species[0].metricRules = [
			metricRule('difference', linear, 'heading-azimuth', [0, 0.5])
		];
		const circularResult = await run(circular, {
			selfMetric: 0.95,
			neighborMetric: 0.05,
			metricId: 8
		});
		close(
			circularResult.magnitude / roleResults.self.magnitude,
			0.8,
			`${kind} circular Difference across wrap`,
			5e-4
		);
		const doubled = sceneFor(kind);
		doubled.species[0].metricRules = [
			metricRule('self'),
			{ ...metricRule('self'), id: 'metric-second' }
		];
		close(
			(await run(doubled)).magnitude / roleResults.self.magnitude,
			2,
			`${kind} both metric slots contribute`
		);
		console.log(
			`PASS ${kind}: Neighbor/Self/absolute and circular Difference, LUT inversion/muting, two rule slots, immutable input metrics`
		);

		const wildcard = pair('flee', 1, '*');
		const explicitIgnore = pair('ignore');
		for (const rules of [
			[wildcard, explicitIgnore],
			[explicitIgnore, wildcard]
		]) {
			const scene = sceneFor(kind);
			scene.speciesRules = rules;
			stationary(await run(scene), `${kind} explicit Ignore supersedes wildcard in either order`);
		}
		const fallback = sceneFor(kind);
		fallback.speciesRules = [wildcard];
		negative((await run(fallback)).toward, `${kind} wildcard fallback applies`);
		const explicitZero = sceneFor(kind);
		explicitZero.speciesRules = [wildcard, pair('chase', 0)];
		stationary(await run(explicitZero), `${kind} explicit zero strength supersedes fallback`);
		console.log(
			`PASS ${kind}: explicit Ignore and zero strength precedence, independent of array order`
		);
		for (const sameSpecies of [false, true]) {
			const scene = sceneFor(kind);
			scene.dynamics.collision = 1;
			const collision = await run(scene, { distance: 0, sameSpecies, resting: true });
			assert.ok(
				collision.separation > 0.05,
				`${kind} ${sameSpecies ? 'same' : 'cross'}-species coincident agents separate`
			);
			assert.ok(
				collision.acceleration <= scene.species[0].force + 1e-4,
				`${kind} contact respects steering force limit`
			);
			assert.ok(
				collision.magnitude <= scene.species[0].speed + 1e-5,
				`${kind} contact respects velocity speed limit`
			);
			assert.ok(
				collision.travel <= scene.species[0].speed * scene.dynamics.fixedDt + 1e-5,
				`${kind} projected travel respects intrinsic speed limit`
			);
			const repeated = await run(scene, { distance: 0, sameSpecies, resting: true });
			close(
				repeated.separation,
				collision.separation,
				`${kind} seeded contact recovery is deterministic`,
				1e-7
			);
		}
		console.log(
			`PASS ${kind}: coincident same/cross-species contact projection, deterministic finite separation, force/speed/travel limits`
		);
		const baseline = sceneFor(kind);
		baseline.species[0].cohesion = 1;
		const nearCenter = await run(baseline, { distance: 0.3, sameSpecies: true });
		const farCenter = await run(baseline, { distance: 3, sameSpecies: true });
		positive(nearCenter.toward, `${kind} baseline cohesion pulls toward center`);
		close(
			nearCenter.magnitude / farCenter.magnitude,
			0.15,
			`${kind} baseline spring weakens near center`,
			5e-4
		);
		close(
			nearCenter.heading,
			0,
			`${kind} baseline cohesion adds no target-heading or damping term`
		);
		const conforming = sceneFor(kind);
		conforming.species[0].alignment = 1;
		const normal = await run(conforming, { sameSpecies: true, simulationTime: 0.5, tick: 30 });
		const rebel = structuredClone(conforming);
		rebel.species[0].rebels = { fraction: 1, strength: 1, period: 8, duration: 1.5 };
		const active = await run(rebel, { sameSpecies: true, simulationTime: 0.5, tick: 30 });
		const inactive = await run(rebel, { sameSpecies: true, simulationTime: 3, tick: 180 });
		assert.ok(
			active.magnitude < normal.magnitude * 0.1,
			`${kind} rebels mainly suppress conformity`
		);
		close(
			inactive.magnitude,
			normal.magnitude,
			`${kind} conformity resumes after physical-time window`
		);
		const alternateDt = structuredClone(rebel);
		alternateDt.dynamics.fixedDt = 1 / 30;
		const sameTime = await run(alternateDt, { sameSpecies: true, simulationTime: 0.5, tick: 15 });
		close(
			active.magnitude / rebel.dynamics.fixedDt,
			sameTime.magnitude / alternateDt.dynamics.fixedDt,
			`${kind} rebel epoch and direction depend on physical simulation time`,
			5e-5
		);
		close(
			active.toward / rebel.dynamics.fixedDt,
			sameTime.toward / alternateDt.dynamics.fixedDt,
			`${kind} same seed/time preserves rebel direction across tick sizes`,
			5e-5
		);
		console.log(
			`PASS ${kind}: displacement-spring baseline cohesion and physical-time rebel conformity windows`
		);
		await verifyIntegerNoise(kind);
		await verifyCruiseAndQueries(kind);
	}
	for (const kind of ['volume', 'surface']) {
		const random = randomMeasurements(kind);
		await compareMeasurements(`random ${kind}`, random.scene, random.agents);
	}
	const periodic = randomMeasurements('volume', true);
	await compareMeasurements(
		'periodic volume with partial edge cells',
		periodic.scene,
		periodic.agents
	);
	for (const geometry of [structuredVolume(), structuredSurface()]) {
		await compareMeasurements(
			`structured ${geometry.scene.world.kind} clusters`,
			geometry.scene,
			geometry.agents,
			geometry.anchors
		);
	}
	const refresh = randomMeasurements('volume');
	const retained = new Float32Array(refresh.agents.length * METRIC_STRIDE);
	for (let i = 0; i < refresh.agents.length; i++) {
		retained.set(
			[
				9, 1.25, 2.75, 999, 100, 0.3125, 0.625, -0.375, 0.9375, 3.125, 0.0625, 0.8125, 0.31, -0.42,
				0.27, 32767
			],
			i * METRIC_STRIDE
		);
		if (i % 3 === 0) retained[i * METRIC_STRIDE] = -1;
	}
	await compareMeasurements(
		'alpha-zero refresh with surviving filters and new-agent sentinels',
		refresh.scene,
		refresh.agents,
		[],
		{ alpha: 0, priorMetrics: retained }
	);
	await verifyColorChannels();
	await verifyRetainedTrails();
	await gpu.gpu.queue.onSubmittedWorkDone();
	await gpu.settled();
	assert.deepEqual(errors, [], 'no native GPU validation errors');
	console.log('All native behavior and metric-causality probes passed.');
} finally {
	gpu.dispose();
}
