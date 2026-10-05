import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, compute } from 'vgpu/node';

// One production simulation tick against the ordinary TypeScript interaction
// oracle. Baseline flocking, propulsion, contacts, noise, cursor and obstacles
// are absent, so acceleration must come from the directed/metric rules alone.
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
const gridSource = (await resolveShader({ entry: resolve('src/lib/gpu/shaders/grid.wgsl') })).wgsl;
const simulationSource = (
	await resolveShader({ entry: resolve('src/lib/gpu/shaders/simulate.wgsl') })
).wgsl;
const gpu = await init({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const indexPasses = Object.fromEntries(
	[
		'clear_grid',
		'count_particles',
		'prefix_cells',
		'prefix_blocks',
		'finish_prefix',
		'scatter_particles'
	].map((entry) => [entry, compute(gpu, gridSource, { entry })])
);
const simulation = compute(gpu, simulationSource, { entry: 'simulate' });
const worlds = [
	{ kind: 'volume', shape: 'box', halfExtents: [30, 30, 30], boundaries: 'reflect' },
	{ kind: 'surface', shape: 'plane', halfExtents: [30, 30], boundaries: 'reflect' },
	{ kind: 'surface', shape: 'sphere', radius: 24 },
	{ kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 20 },
	{ kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 }
];
const limited = (vector, maximum) =>
	model.scale(vector, Math.min(1, maximum / Math.max(model.magnitude(vector), 1e-7)));
function closeVector(actual, expected, name, tolerance) {
	for (let axis = 0; axis < 3; axis++)
		assert.ok(
			Math.abs(actual[axis] - expected[axis]) <= tolerance,
			`${name}, axis ${axis}: ${actual[axis]} vs ${expected[axis]} (tolerance ${tolerance})`
		);
}
function sceneFor(world) {
	const scene = model.createDefaultScene();
	scene.world = world;
	scene.species = ['observer', 'leader', 'other'].map((key) => model.createSpecies(key));
	for (const species of scene.species) {
		species.population = 0;
		species.speed = 4;
		species.cruiseSpeed = 0;
		species.force = 2;
		species.perception = world.shape === 'torus' ? 2.2 : 4;
		species.size = 0.001;
		species.alignment = 0;
		species.cohesion = 0;
		species.separation = 0;
		species.rebels.fraction = 0;
		species.metricRules = [];
		species.cursor.response = 'ignore';
		species.cursor.vortex = 0;
	}
	scene.speciesRules = [];
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.dynamics.orbitAxis = [0, 1, 0];
	scene.forces.enabled = false;
	scene.forces.radius = scene.species[0].perception;
	scene.obstacles = [];
	return scene;
}
function fixture(world) {
	const scene = sceneFor(world);
	const curved = world.kind === 'surface' && world.shape !== 'plane';
	const origin = curved
		? [world.shape === 'torus' ? world.majorRadius + world.tubeRadius : world.radius, 0, 0]
		: [0, 0, 0];
	const forward = curved ? [0, 0, 1] : [1, 0, 0];
	const side = curved ? [0, 1, 0] : [0, 0, 1];
	const agent = (id, speciesKey, distance, forwardSpeed = 0, sideSpeed = 0) => {
		const position = model.worldExp(world, origin, model.scale(forward, distance));
		return {
			id,
			birth: id,
			speciesKey,
			position,
			velocity: model.worldTransport(
				world,
				model.add(model.scale(forward, forwardSpeed), model.scale(side, sideSpeed)),
				origin,
				position
			)
		};
	};
	const rule = (behavior, to = 'leader', strength = 1) => ({
		id: `rule-${to}`,
		from: 'observer',
		to,
		behavior,
		strength,
		radius: scene.species[0].perception
	});
	return { scene, agent, rule, forward, side };
}
function buildIndex(resources, count, cells) {
	for (const pass of Object.values(indexPasses)) pass.set(resources);
	indexPasses.clear_grid.dispatch(Math.ceil(cells / 256));
	indexPasses.count_particles.dispatch(Math.ceil(count / 256));
	indexPasses.prefix_cells.dispatch(Math.ceil(cells / 256));
	indexPasses.prefix_blocks.dispatch(1);
	indexPasses.finish_prefix.dispatch(Math.ceil(cells / 256));
	indexPasses.scatter_particles.dispatch(Math.ceil(count / 256));
}
let cases = 0;
async function compare(name, scene, initial) {
	for (const species of scene.species)
		species.population = initial.filter((agent) => agent.speciesKey === species.key).length;
	model.assertScene(scene);
	// Reference the same f32 initial state the production buffers receive.
	const packed = packing.packParticles(initial, scene, 1);
	const agents = packing.unpackParticles(packed, scene, initial.length);
	for (let i = 0; i < agents.length; i++)
		for (let j = i + 1; j < agents.length; j++)
			assert.ok(
				model.worldDistance(scene.world, agents[i].position, agents[j].position) > 0.002,
				`${name}: probe must not contain body contacts`
			);
	const snapshot = model.measureAllPairs(scene, agents);
	const acceleration = model.interactionAccelerationsAllPairs(scene, agents, snapshot)[0];
	const source = scene.species[0],
		observer = agents[0],
		dt = scene.dynamics.fixedDt;
	const bounded = limited(
		model.worldTangent(scene.world, acceleration, observer.position),
		source.force
	);
	const candidateVelocity = limited(
		model.add(observer.velocity, model.scale(bounded, dt)),
		source.speed
	);
	const expected = model.worldAdvance(
		scene.world,
		observer.position,
		candidateVelocity,
		dt,
		source.size,
		observer.velocity
	);
	const expectedPrior = expected.transportedPriorVelocity ?? observer.velocity;
	const expectedAcceleration = model.scale(
		model.subtract(expected.velocity, expectedPrior),
		1 / dt
	);
	const gridDefinition = packing.gridDefinition(scene),
		count = agents.length,
		owned = [];
	const allocate = (label, size) => {
		const buffer = gpu.device.createBuffer({
			label: `interaction parity ${label}`,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(buffer);
		return buffer;
	};
	const config = allocate('config', 16384),
		current = allocate('current', count * packing.PARTICLE_BYTES),
		next = allocate('next', count * packing.PARTICLE_BYTES),
		grid = allocate('complete grid', gridDefinition.count * 12),
		indices = allocate('indices', count * 4),
		blocks = allocate('block prefix', Math.ceil(gridDefinition.count / 256) * 4),
		metrics = allocate('immutable metrics', count * packing.METRIC_BYTES),
		species = allocate('species', scene.species.length * packing.SPECIES_ROWS * 16),
		pairRules = allocate('rules', scene.species.length ** 2 * 16);
	try {
		const metricWords = new Float32Array((count * packing.METRIC_BYTES) / 4);
		for (let i = 0; i < count; i++)
			for (const [field, key] of packing.METRIC_ORDER.entries())
				metricWords[(i * packing.METRIC_BYTES) / 4 + field] = snapshot[i][key];
		config.write(
			packing.packConfig(scene, {
				population: count,
				tick: 1,
				historyHead: 0,
				validHistory: 1,
				smoothingAlpha: 1
			})
		);
		current.write(packed);
		metrics.write(metricWords);
		species.write(packing.packSpecies(scene));
		pairRules.write(packing.packPairRules(scene));
		buildIndex({ config, particles: current, grid, indices, blocks }, count, gridDefinition.count);
		simulation.set({ config, current, next, grid, indices, metrics, species, pairRules });
		simulation.dispatch(Math.ceil(count / 256));
		const output = await next.read(count * packing.PARTICLE_BYTES);
		const state = packing.unpackParticles(output, scene, count)[0];
		const previous = [...new Float32Array(output).subarray(8, 11)];
		const observed = model.scale(model.subtract(state.velocity, previous), 1 / dt);
		assert.ok(observed.every(Number.isFinite), `${name}: finite acceleration`);
		// Torus uses approximate production chart geometry and an actual motion
		// path. Compare velocity difference in the final frame, using its stored
		// transported prior velocity, rather than treating curvature as steering.
		const tolerance =
			scene.world.shape === 'torus' ? 0.002 : scene.world.kind === 'surface' ? 0.0004 : 0.00003;
		closeVector(observed, expectedAcceleration, `${name}: acceleration`, tolerance);
		closeVector(state.velocity, expected.velocity, `${name}: velocity`, tolerance * dt + 0.000004);
		closeVector(state.position, expected.position, `${name}: position`, 0.000015);
		assert.deepEqual(
			new Float32Array(await metrics.read(metricWords.byteLength)),
			metricWords,
			`${name}: immutable metrics`
		);
		cases++;
		return model.worldTransport(scene.world, observed, state.position, observer.position);
	} finally {
		for (const buffer of owned) buffer.destroy();
	}
}
try {
	for (const world of worlds) {
		const prefix = world.shape;
		{
			const { scene, agent, rule } = fixture(world);
			scene.speciesRules = [rule('align')];
			const force = await compare(`${prefix}: equal subcap velocity`, scene, [
				agent(1, 'observer', 0, 0, 1),
				agent(2, 'leader', 1, 0, 1)
			]);
			assert.ok(model.magnitude(force) < 0.0004, `${prefix}: equal velocity must not accelerate`);
		}
		{
			const { scene, agent, rule, side } = fixture(world);
			scene.speciesRules = [rule('align')];
			const force = await compare(`${prefix}: stationary Align brakes`, scene, [
				agent(1, 'observer', 0, 0, 1),
				agent(2, 'leader', 1)
			]);
			assert.ok(model.dot(force, side) < -0.2, `${prefix}: stationary target brakes`);
		}
		{
			const { scene, agent, rule, side } = fixture(world);
			scene.speciesRules = [rule('mirror')];
			const force = await compare(`${prefix}: actual Mirror magnitude`, scene, [
				agent(1, 'observer', 0),
				agent(2, 'leader', 1, 0, 0.4)
			]);
			assert.ok(
				model.dot(force, side) < -0.1 && model.magnitude(force) < 0.4,
				`${prefix}: Mirror preserves actual target magnitude`
			);
		}
		for (const otherBehavior of ['align', 'chase']) {
			const { scene, agent, rule, side } = fixture(world);
			scene.speciesRules = [rule('align'), rule(otherBehavior, 'other')];
			const observer = agent(1, 'observer', 0),
				leader = agent(2, 'leader', 1, 0, 1);
			const sparse = await compare(`${prefix}: sparse ${otherBehavior} target`, scene, [
				observer,
				leader,
				agent(3, 'other', 1.2, 1)
			]);
			const dense = await compare(`${prefix}: dense ${otherBehavior} target`, scene, [
				observer,
				leader,
				...Array.from({ length: 100 }, (_, i) => agent(i + 3, 'other', 1.2 + i * 0.003, 1))
			]);
			assert.ok(
				Math.abs(model.dot(sparse, side) - model.dot(dense, side)) < 0.002,
				`${prefix}: unrelated target population cannot dilute leader alignment`
			);
		}
		{
			const { scene, agent, rule, side } = fixture(world);
			scene.speciesRules = [rule('spiral')];
			const single = await compare(`${prefix}: one Spiral neighbor`, scene, [
				agent(1, 'observer', 0),
				agent(2, 'leader', 1)
			]);
			const many = await compare(`${prefix}: coherent Spiral handedness`, scene, [
				agent(1, 'observer', 0),
				...[2, 3, 999, 0xfffffffe].map((id, i) => agent(id, 'leader', 1 + i * 0.01))
			]);
			assert.ok(
				model.dot(single, side) > 0 && model.dot(many, side) > 0,
				`${prefix}: same species-pair Spiral handedness`
			);
		}
		{
			const { scene, agent, side } = fixture(world);
			scene.species[0].metricRules = [
				{
					id: 'active-speed',
					metric: 'speed',
					role: 'neighbor',
					range: [0, 1],
					curve: model.curvePreset('linear'),
					behavior: 'align',
					strength: 1,
					radius: scene.species[0].perception
				}
			];
			const observer = agent(1, 'observer', 0),
				active = agent(2, 'leader', 1, 0, 1);
			const alone = await compare(`${prefix}: one active metric neighbor`, scene, [
				observer,
				active
			]);
			const zeros = await compare(`${prefix}: zero metric activations excluded`, scene, [
				observer,
				active,
				...Array.from({ length: 99 }, (_, i) => agent(i + 3, 'leader', 1.2 + i * 0.003))
			]);
			assert.ok(
				Math.abs(model.dot(alone, side) - model.dot(zeros, side)) < 0.002,
				`${prefix}: inactive metric neighbors cannot dilute active response`
			);
			const matched = await compare(`${prefix}: metric velocity matching`, scene, [
				agent(1, 'observer', 0, 0, 1),
				active
			]);
			assert.ok(
				model.magnitude(matched) < 0.0004,
				`${prefix}: metric Align matches actual velocity`
			);
		}
		{
			const { scene, agent, rule, forward } = fixture(world);
			scene.speciesRules = [rule('flee', 'leader', 0.1)];
			const alone = await compare(`${prefix}: one urgent Flee threat`, scene, [
				agent(1, 'observer', 0),
				agent(2, 'leader', 1)
			]);
			const many = await compare(`${prefix}: urgent Flee sums threats`, scene, [
				agent(1, 'observer', 0),
				agent(2, 'leader', 1),
				agent(3, 'leader', 1.01),
				agent(4, 'leader', 1.02)
			]);
			assert.ok(
				-model.dot(many, forward) > -model.dot(alone, forward) * 2.5,
				`${prefix}: Flee adds urgent threats instead of averaging`
			);
		}
	}
	await gpu.gpu.queue.onSubmittedWorkDone();
	await gpu.settled();
	assert.deepEqual(errors, [], 'no native GPU validation errors');
	console.log(
		`${cases} numeric interaction parity cases passed across box, plane, sphere, cylinder and torus.`
	);
} finally {
	gpu.dispose();
}
