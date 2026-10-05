import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, compute, draw, frame, target } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

// Native production-kernel probes for intrinsically flat planes and cylinders.
// No benchmark timings: this is correctness validation against independent CPU
// geometry/measurement oracles and actual depth-tested production rendering.
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

const sources = Object.fromEntries(
	await Promise.all(
		['grid', 'simulate', 'metrics', 'history', 'boids', 'trails', 'world', 'common'].map(
			async (name) => [
				name,
				(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`) })).wgsl
			]
		)
	)
);
const gpu = await init({
	requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxStorageBuffersInVertexStage: 5 }
});
const previousShaderStage = globalThis.GPUShaderStage;
if (!previousShaderStage)
	Object.defineProperty(globalThis, 'GPUShaderStage', {
		value: Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }),
		configurable: true
	});
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
let runtime;
const circularFields = new Set([
	'headingAzimuth',
	'centerBearing',
	'flowOrbit',
	'centerOrbitAngle'
]);
const tolerances = [
	3e-5, 9e-4, 3e-3, 0, 8e-5, 4e-4, 2e-5, 3e-5, 3e-5, 7e-5, 4e-5, 4e-5, 5e-5, 8e-5, 4e-5
];
const close = (actual, expected, name, tolerance = 3e-5) =>
	assert.ok(Math.abs(actual - expected) <= tolerance, `${name}: ${actual} vs ${expected}`);
const vectorClose = (actual, expected, name, tolerance = 4e-5) =>
	actual.forEach((value, axis) => close(value, expected[axis], `${name}[${axis}]`, tolerance));
const length = model.magnitude;
function sceneFor(shape, boundaries = 'reflect') {
	const scene = model.createDefaultScene();
	scene.world =
		shape === 'plane'
			? { kind: 'surface', shape, halfExtents: [12.1, 10.7], boundaries }
			: { kind: 'surface', shape, radius: 12, halfHeight: 10.7 };
	scene.seed = 0xb739ac11;
	scene.dynamics.fixedDt = 1 / 60;
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.dynamics.metricSmoothingSeconds = 0;
	scene.forces.enabled = false;
	scene.obstacles = [];
	scene.species.forEach((species, i) => {
		species.key = i ? 'neighbor' : 'observer';
		species.population = 1;
		species.size = 0.08;
		species.speed = 6;
		species.cruiseSpeed = 0;
		species.force = 2;
		species.perception = 2.3 + i * 0.4;
		species.alignment = 0;
		species.cohesion = 0;
		species.separation = 0;
		species.rebels.fraction = 0;
		species.metricRules = [];
		species.cursor.response = 'ignore';
		species.cursor.vortex = 0;
		species.trail = { length: 2, opacity: 1, width: 0.16 };
		for (const channel of ['hue', 'saturation', 'lightness'])
			species.visual[channel].enabled = false;
	});
	scene.speciesRules = [];
	return scene;
}
const agent = (position, velocity = [0, 0, 0], id = 1, speciesKey = 'observer') => ({
	id,
	birth: id,
	speciesKey,
	position,
	velocity
});
const originFor = (scene) =>
	scene.world.shape === 'plane' ? [0, 0, 0] : [scene.world.radius, 0, 0];
const pairFor = (scene, distance = 3) => {
	const origin = originFor(scene);
	const toward = scene.world.shape === 'plane' ? [0, 0, 1] : [0, 0, 1];
	const heading = scene.world.shape === 'plane' ? [-1, 0, 0] : [0, 1, 0];
	const position = model.worldExp(scene.world, origin, model.scale(toward, distance));
	return [
		agent(origin),
		agent(
			position,
			model.worldTransport(scene.world, model.scale(heading, 2), origin, position),
			2,
			'neighbor'
		)
	];
};

async function withCase(scene, agents, action, { prior } = {}) {
	const count = agents.length;
	const grid = packing.gridDefinition(scene);
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
	const buffers = {
		config: allocate('surface config', 16384),
		particles: [allocate('surface state A', count * 64), allocate('surface state B', count * 64)],
		metrics: [
			allocate('surface metrics A', count * METRIC_BYTES),
			allocate('surface metrics B', count * METRIC_BYTES)
		],
		history: allocate(
			'surface position history',
			count * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES
		),
		grid: allocate('complete surface grid', grid.count * 12),
		indices: allocate('surface indices', count * 4),
		blocks: allocate('surface prefix', Math.ceil(grid.count / 256) * 4),
		species: allocate('surface species', scene.species.length * 64 * 16),
		pairRules: allocate('surface pair rules', scene.species.length ** 2 * 16)
	};
	const bytes = packing.packParticles(agents, scene, 1);
	const canonical = packing.unpackParticles(bytes, scene, count);
	const canonicalPrior = prior
		? packing.unpackParticles(packing.packParticles(prior, scene, 1), scene, count)
		: canonical;
	const floats = new Float32Array(bytes);
	canonical.forEach((current, i) =>
		floats.set(
			model.worldTransport(
				scene.world,
				canonicalPrior[i].velocity,
				canonicalPrior[i].position,
				current.position
			),
			i * 16 + 8
		)
	);
	buffers.particles.forEach((buffer) => buffer.write(bytes));
	buffers.species.write(packing.packSpecies(scene));
	buffers.pairRules.write(packing.packPairRules(scene));
	const records = new Float32Array(count * 64 * 4);
	canonical.forEach((a, i) => {
		for (let slot = 0; slot < 64; slot++) records.set([...a.position, 1], (i * 64 + slot) * 4);
	});
	buffers.history.write(records);
	let side = 0,
		metricSide = 0,
		tick = 0;
	const configure = (options = {}) =>
		buffers.config.write(
			packing.packConfig(scene, {
				population: count,
				tick,
				historyHead: tick % 64,
				validHistory: Math.min(63, tick + 1),
				smoothingAlpha: 1,
				sampleHistory: true,
				historyElapsed: 0,
				...options
			})
		);
	const state = async () => {
		const bytes = await buffers.particles[side].read(count * 64);
		return { bytes, agents: packing.unpackParticles(bytes, scene, count) };
	};
	const measured = async () =>
		new Float32Array(await buffers.metrics[metricSide].read(count * METRIC_BYTES));
	try {
		if (!runtime)
			runtime = await createComputeRuntime(
				gpu,
				{
					grid: sources.grid,
					simulation: sources.simulate,
					metrics: sources.metrics,
					history: sources.history
				},
				buffers
			);
		else runtime.rebind(buffers);
		configure();
		runtime.bootstrap(side, metricSide, count, grid.count);
		metricSide = 1 - metricSide;
		await action({
			buffers,
			grid,
			canonical,
			canonicalPrior,
			state,
			measured,
			configure,
			get side() {
				return side;
			},
			get metricSide() {
				return metricSide;
			},
			step(options = {}) {
				tick++;
				configure(options);
				runtime.tick(side, metricSide, count, grid.count, true);
				side = 1 - side;
				metricSide = 1 - metricSide;
			}
		});
	} finally {
		await gpu.gpu.queue.onSubmittedWorkDone();
		for (const buffer of owned) buffer.destroy();
	}
}

async function verifyMeasurements(name, scene, agents) {
	const prior = agents.map((a, i) => {
		const angle = 0.08 + (i % 7) * 0.03;
		const rotated = model.add(
			model.scale(a.velocity, Math.cos(angle)),
			model.scale(
				model.cross(model.worldNormal(scene.world, a.position), a.velocity),
				Math.sin(angle)
			)
		);
		return { ...a, velocity: i % 11 === 0 ? [0, 0, 0] : model.scale(rotated, 0.84) };
	});
	await withCase(
		scene,
		agents,
		async (data) => {
			const actual = await data.measured();
			const expected = model.measureAllPairs(scene, data.canonical, data.canonicalPrior);
			const grid = new Uint32Array(await data.buffers.grid.read(data.grid.count * 12));
			const indices = new Uint32Array(await data.buffers.indices.read(agents.length * 4));
			assert.equal(
				grid.subarray(0, data.grid.count).reduce((a, b) => a + b, 0),
				agents.length
			);
			assert.deepEqual(
				[...indices].sort((a, b) => a - b),
				agents.map((_, i) => i),
				'complete scatter preserves every member'
			);
			for (let cell = 0; cell < data.grid.count; cell++)
				assert.equal(
					grid[cell],
					grid[data.grid.count * 2 + cell],
					'all scatter cursors equal complete counts'
				);
			for (let i = 0; i < agents.length; i++) {
				for (let field = 0; field < packing.METRIC_ORDER.length; field++) {
					const key = packing.METRIC_ORDER[field];
					const reference = expected[i][key];
					const observed = actual[i * METRIC_STRIDE + field];
					assert.ok(Number.isFinite(observed), `${name} ${key} is finite`);
					let error = Math.abs(observed - reference);
					if (circularFields.has(key)) error = Math.min(error, 1 - error);
					const tolerance = tolerances[field] + (field === 4 ? Math.abs(reference) * 3e-6 : 0);
					assert.ok(
						error <= tolerance,
						`${name} ${key}[${i}]: GPU=${observed}, CPU=${reference}, error=${error}`
					);
				}
			}
			console.log(
				`PASS ${name}: complete ${agents.length}-agent scatter and all 15 all-pairs measurements`
			);
		},
		{ prior }
	);
}
function randomCase(shape, periodic = false) {
	const scene = sceneFor(shape, periodic ? 'periodic' : 'reflect');
	scene.species.forEach((s, i) => {
		s.population = 71 + i * 13;
	});
	if (shape === 'plane') scene.world.halfExtents = [5.1, 4.7];
	else {
		scene.world.radius = 4.1;
		scene.world.halfHeight = 4.7;
	}
	return { scene, agents: model.initializePopulation(scene).agents };
}
function denseCase(shape) {
	const scene = sceneFor(shape);
	const center = originFor(scene);
	const [a, b] = model.localFrame(scene.world, center);
	const agents = Array.from({ length: 145 }, (_, i) => {
		const phase = i * 2.3999632297;
		const distance = 0.05 + (i % 23) * 0.025;
		const position = model.worldExp(
			scene.world,
			center,
			model.add(
				model.scale(a, Math.cos(phase) * distance),
				model.scale(b, Math.sin(phase) * distance)
			)
		);
		const velocity = model.worldTransport(
			scene.world,
			model.add(model.scale(a, 1 + Math.cos(i) * 0.3), model.scale(b, Math.sin(i) * 0.4)),
			center,
			position
		);
		return agent(position, velocity, i + 1, i % 2 ? 'observer' : 'neighbor');
	});
	return { scene, agents };
}
async function verifyFreeMotion(shape) {
	const scene = sceneFor(shape);
	scene.species.forEach((s) => {
		s.force = 0;
		s.speed = 8;
		s.size = 0.02;
	});
	const start = shape === 'plane' ? [0, 0, 0] : [-scene.world.radius, 0, 0];
	const velocity = shape === 'plane' ? [2, 0, 1] : [0, 0, -3];
	await withCase(scene, [agent(start, velocity)], async (data) => {
		let reference = { position: data.canonical[0].position, velocity: data.canonical[0].velocity };
		for (let i = 0; i < 120; i++) {
			reference = model.worldAdvance(
				scene.world,
				reference.position,
				reference.velocity,
				scene.dynamics.fixedDt,
				scene.species[0].size
			);
			data.step();
		}
		const [actual] = (await data.state()).agents;
		vectorClose(actual.position, reference.position, `${shape} exact free trajectory`, 2e-4);
		vectorClose(actual.velocity, reference.velocity, `${shape} transported free velocity`, 5e-5);
		const metrics = await data.measured();
		close(metrics[0], length(velocity), `${shape} speed`, 5e-5);
		close(metrics[1], 0, `${shape} covariant turn`, 8e-5);
		close(metrics[2], 0, `${shape} covariant acceleration`, 1e-4);
		close(
			model.dot(model.worldNormal(scene.world, actual.position), actual.velocity),
			0,
			`${shape} tangent velocity`,
			2e-5
		);
	});
	console.log(
		`PASS ${shape}: 120 free ticks, seam crossing, conserved speed/tangency and zero covariant derivatives`
	);
}
async function verifyLargeSteps(shape, periodic = false) {
	const scene = sceneFor(shape, periodic ? 'periodic' : 'reflect');
	scene.dynamics.fixedDt = 0.1;
	scene.species.forEach((s) => {
		s.force = 0;
		s.speed = 200;
		s.size = 0.005;
		s.perception = 0.1;
	});
	if (shape === 'plane') scene.world.halfExtents = [0.2, 0.17];
	else {
		scene.world.radius = 0.2;
		scene.world.halfHeight = 0.17;
	}
	const position = shape === 'plane' ? [0.1, 0, 0.04] : [0.2, 0.04, 0];
	const velocity = shape === 'plane' ? [-80, 0, 90] : [0, 80, 90];
	await withCase(scene, [agent(position, velocity)], async (data) => {
		const expected = model.worldAdvance(
			scene.world,
			data.canonical[0].position,
			data.canonical[0].velocity,
			scene.dynamics.fixedDt,
			scene.species[0].size
		);
		data.step();
		const [actual] = (await data.state()).agents;
		vectorClose(actual.position, expected.position, `${shape} repeated boundary position`, 3e-5);
		vectorClose(actual.velocity, expected.velocity, `${shape} repeated boundary velocity`, 3e-3);
		close(length(actual.velocity), length(velocity), `${shape} boundary speed`, 5e-5);
	});
	console.log(
		`PASS ${shape} ${periodic ? 'periodic' : 'reflect'}: multiple wraps/reflections in a single tick`
	);
}
async function verifyInteractions(shape) {
	const results = {};
	for (const behavior of model.BEHAVIORS) {
		const scene = sceneFor(shape);
		scene.speciesRules = [
			{ id: behavior, from: 'observer', to: 'neighbor', behavior, strength: 1, radius: 12 }
		];
		await withCase(scene, pairFor(scene), async (data) => {
			data.step();
			const [state] = (await data.state()).agents;
			const velocity = model.worldTransport(
				scene.world,
				state.velocity,
				state.position,
				originFor(scene)
			);
			results[behavior] = {
				toward: velocity[2],
				heading: shape === 'plane' ? -velocity[0] : velocity[1],
				magnitude: length(velocity)
			};
			assert.ok(length(velocity) <= scene.species[0].force * scene.dynamics.fixedDt + 1e-5);
			close(
				model.dot(model.worldNormal(scene.world, state.position), state.velocity),
				0,
				`${shape} ${behavior} tangent`,
				2e-5
			);
		});
	}
	const positive = (v, label) => assert.ok(v > 1e-4, `${shape} ${label}: ${v}`);
	const negative = (v, label) => assert.ok(v < -1e-4, `${shape} ${label}: ${v}`);
	close(results.ignore.magnitude, 0, `${shape} Ignore`);
	negative(results.flee.toward, 'Flee');
	positive(results.chase.toward, 'Chase');
	positive(results.chase.heading, 'Chase lead');
	positive(results.cohere.toward, 'Cohere');
	positive(results.align.heading, 'Align');
	// Both frames have positive cross(normal,toward) opposite target heading.
	negative(results.orbit.heading, 'Orbit handedness');
	positive(results.follow.toward, 'Follow');
	negative(results.follow.heading, 'Follow behind');
	negative(results.guard.toward, 'Guard inner clearance');
	negative(results.disperse.toward, 'Disperse');
	positive(results.mob.toward, 'Mob');
	negative(results.mirror.heading, 'Mirror');
	positive(results.spiral.toward, 'Spiral');
	for (const sameSpecies of [false, true]) {
		const scene = sceneFor(shape);
		scene.dynamics.collision = 1;
		const point = originFor(scene);
		await withCase(
			scene,
			[agent(point), agent(point, [0, 0, 0], 2, sameSpecies ? 'observer' : 'neighbor')],
			async (data) => {
				data.step();
				const { agents, bytes } = await data.state();
				assert.ok(new Float32Array(bytes).slice(0, 12).every(Number.isFinite));
				assert.ok(
					length(model.worldDisplacement(scene.world, agents[0].position, agents[1].position)) >
						0.03,
					`${shape} complete contact recovery`
				);
				for (const a of agents) {
					assert.ok(length(a.velocity) <= scene.species[0].force * scene.dynamics.fixedDt + 1e-5);
					assert.ok(
						length(model.worldDisplacement(scene.world, point, a.position)) <=
							scene.species[0].speed * scene.dynamics.fixedDt + 1e-5
					);
				}
			}
		);
	}
	const scene = sceneFor(shape);
	scene.species.forEach((s) => {
		s.perception = 0.3;
	});
	scene.speciesRules = [
		{ id: 'long', from: 'observer', to: '*', behavior: 'flee', strength: 1, radius: 5 }
	];
	await withCase(scene, pairFor(scene, 4), async (data) => {
		assert.ok(data.grid.width < 5, 'long rule requires multi-cell query');
		data.step();
		const [state] = (await data.state()).agents;
		assert.ok(
			length(state.velocity) > 1e-4,
			`${shape} explicit long radius spans all required cells`
		);
	});
	console.log(
		`PASS ${shape}: all 12 intrinsic behaviors, same/cross contact recovery, force bounds and long per-source queries`
	);
}
async function verifyObstaclesAndFields(shape) {
	const scene = sceneFor(shape);
	const origin = originFor(scene);
	scene.obstacles = [{ id: 'disk', shape: 'sphere', center: origin, radius: 0.7 }];
	scene.obstacleSettings.enabled = true;
	scene.species[0].force = 0;
	await withCase(scene, [agent(origin)], async (data) => {
		data.step();
		const [state] = (await data.state()).agents;
		close(
			length(model.worldDisplacement(scene.world, origin, state.position)),
			0.78,
			`${shape} intrinsic obstacle projection`,
			4e-5
		);
		close(
			model.dot(model.worldNormal(scene.world, state.position), state.velocity),
			0,
			`${shape} obstacle tangent`
		);
	});
	const fieldScene = sceneFor(shape);
	fieldScene.forces.enabled = true;
	fieldScene.forces.radius = 4;
	fieldScene.species[0].cursor.response = 'attract';
	fieldScene.species[0].cursor.strength = 1;
	const position = model.worldExp(fieldScene.world, origin, [0, 0, 2]);
	await withCase(fieldScene, [agent(origin)], async (data) => {
		data.step({ field: { position, active: true, pressed: false } });
		const [state] = (await data.state()).agents;
		assert.ok(
			model.dot(
				model.worldTransport(fieldScene.world, state.velocity, state.position, origin),
				[0, 0, 1]
			) > 1e-4,
			`${shape} intrinsic cursor attraction`
		);
	});
	console.log(`PASS ${shape}: intrinsic obstacle disk projection and tangent force field`);
}

async function verifyGeometryRepresentatives() {
	// Read function names from the public resolved WGSL, then append a standard
	// WGSL entry. The probe invokes the exact helper used by production kernels.
	const deltaName = sources.common.match(/fn\s+(\w+__delta)\s*\(/)?.[1];
	assert.ok(deltaName, 'resolved shared displacement function');
	const shader = `${sources.common}
	@group(0) @binding(0) var<storage,read> input:array<vec4f>;
	@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
	@compute @workgroup_size(32) fn probe(@builtin(global_invocation_id) id:vec3u) {
	 if(id.x>=arrayLength(&result)){return;}
	 let a=input[id.x*3u];let b=input[id.x*3u+1u];let c=input[id.x*3u+2u];
	 result[id.x]=vec4f(${deltaName}(a.xyz,b.xyz,a.w,b.w,c.w,c.xyz),0.0);
	}`;
	const plane = { kind: 'surface', shape: 'plane', halfExtents: [4, 4], boundaries: 'periodic' };
	const cylinder = { kind: 'surface', shape: 'cylinder', radius: 3, halfHeight: 4 };
	const cases = [
		[plane, [-2, 0, -2], [2, 0, 2]],
		[plane, [2, 0, 2], [-2, 0, -2]],
		[plane, [3.9, 0, 3.9], [-3.9, 0, -3.9]],
		[cylinder, [3, 0, 0], [-3, 1, 0]],
		[cylinder, [-3, 1, 0], [3, 0, 0]],
		[cylinder, [3, 0, 0], [-3, 1, -0]],
		[cylinder, [-3, 1, -0], [3, 0, 0]],
		[cylinder, [0, 0, 3], [0, 1, -3]],
		[cylinder, [0, 1, -3], [0, 0, 3]],
		[
			cylinder,
			[-3 * Math.cos(0.01), 0, 3 * Math.sin(0.01)],
			[-3 * Math.cos(0.01), 0, -3 * Math.sin(0.01)]
		]
	];
	const words = new Float32Array(cases.length * 12);
	cases.forEach(([world, a, b], i) => {
		words.set(
			[
				...a,
				world.shape === 'plane' ? 2 : 3,
				...b,
				world.shape === 'plane' ? 1 : 0,
				...model.worldBounds(world),
				world.shape === 'cylinder' ? world.radius : 0
			],
			i * 12
		);
	});
	const input = gpu.device.createBuffer({ size: words.byteLength, usage: ['storage', 'copy_dst'] });
	const result = gpu.device.createBuffer({
		size: cases.length * 16,
		usage: ['storage', 'copy_src']
	});
	try {
		input.write(words);
		const pass = compute(gpu, shader, { entry: 'probe', set: { input, result } });
		pass.dispatch(1);
		const actual = new Float32Array(await result.read(cases.length * 16));
		cases.forEach(([world], i) => {
			const a = [...words.subarray(i * 12, i * 12 + 3)];
			const b = [...words.subarray(i * 12 + 4, i * 12 + 7)];
			vectorClose(
				[...actual.subarray(i * 4, i * 4 + 3)],
				model.worldDisplacement(world, a, b),
				`signed seam/half-period ${i}`,
				2e-5
			);
		});
		console.log(
			'PASS shared plane/cylinder geometry: seams, axes, signed-zero azimuth and both exact half-period representatives'
		);
	} finally {
		input.destroy();
		result.destroy();
	}
}

const visible = (pixels, bright = false) => {
	let count = 0;
	for (let i = 0; i < pixels.length; i += 4)
		if (pixels[i + 3] > 0 && (!bright || Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 40))
			count++;
	return count;
};
async function verifyRendering(shape) {
	const scene = sceneFor(shape);
	scene.species = [scene.species[0]];
	scene.species[0].size = 0.3;
	scene.species[0].trail.width = 0.16;
	scene.species[0].visual.hsl = [0.12, 0.85, 0.65];
	if (shape === 'plane') scene.world.halfExtents = [4, 4];
	else {
		scene.world.radius = 2;
		scene.world.halfHeight = 2;
	}
	const position =
		shape === 'plane' ? [1.4, 0, 0] : [-2 * Math.cos(0.12), 0.4, -2 * Math.sin(0.12)];
	const samples =
		shape === 'plane'
			? [
					[0, 0, 0],
					[-1, 0, 0],
					[-2, 0, 0]
				]
			: [
					[-2 * Math.cos(0.04), 0.2, -2 * Math.sin(0.04)],
					[-2 * Math.cos(0.04), 0, 2 * Math.sin(0.04)],
					[-2 * Math.cos(0.12), -0.2, 2 * Math.sin(0.12)]
				];
	await withCase(scene, [agent(position)], async (data) => {
		const output = target(gpu, { size: [256, 192], format: 'rgba8unorm', depth: true });
		const camera = perspectiveCamera({
			fov: 45,
			aspect: 4 / 3,
			position: shape === 'plane' ? [0, 7, 5] : [-8, 2, 0],
			target: [0, 0, 0],
			near: 0.1,
			far: 100
		});
		const block = {
			viewProjection: camera.viewProjection,
			position: [...camera.worldPosition, 1],
			right: [0, 0, -1, 0],
			up: [0, 1, 0, 0]
		};
		const shell = draw(gpu, {
			shader: sources.world,
			entry: { vertex: 'vs_shell', fragment: 'fs_shell' },
			writeMask: [],
			vertices: 10800,
			depth: { write: true },
			set: { config: data.buffers.config, camera: block }
		});
		const body = draw(gpu, {
			shader: sources.boids,
			vertices: 36,
			depth: { write: true },
			set: {
				config: data.buffers.config,
				particles: data.buffers.particles[0],
				metrics: data.buffers.metrics[1],
				species: data.buffers.species,
				camera: block
			}
		});
		const trails = draw(gpu, {
			shader: sources.trails,
			vertices: 18,
			blend: 'premultiplied',
			depth: { write: false, compare: 'less-equal' },
			set: {
				config: data.buffers.config,
				particles: data.buffers.particles[0],
				metrics: data.buffers.metrics[1],
				species: data.buffers.species,
				history: data.buffers.history,
				camera: block
			}
		});
		const records = new Float32Array(64 * 4);
		for (let slot = 0; slot < 64; slot++) records.set([...samples[0], 1], slot * 4);
		samples.forEach((point, age) => records.set([...point, 1], (63 - age) * 4));
		data.buffers.history.write(records);
		data.configure({
			historyHead: 63,
			validHistory: 3,
			historyElapsed: 0.04,
			sampleHistory: false
		});
		const render = async ({ shellVisible = true, bodyVisible = false, vertices = 18 } = {}) => {
			const submitted = frame(gpu, (f) =>
				f.pass({ target: output, clear: [0, 0, 0, 0], clearDepth: 1 }, (pass) => {
					if (shellVisible) pass.draw(shell);
					pass.draw(trails, { instances: 1, vertices });
					if (bodyVisible) pass.draw(body, { instances: 1 });
				})
			);
			await Promise.all([submitted.done, gpu.gpu.queue.onSubmittedWorkDone()]);
			return output.color.read({ mipLevel: 0, region: 'all' });
		};
		const projected = (point) => {
			const m = camera.viewProjection;
			const clip = [0, 1, 2, 3].map(
				(row) => m[row] * point[0] + m[4 + row] * point[1] + m[8 + row] * point[2] + m[12 + row]
			);
			return [((clip[0] / clip[3]) * 0.5 + 0.5) * 256, (0.5 - (clip[1] / clip[3]) * 0.5) * 192];
		};
		const near = (pixels, point, radius = 3) => {
			const [x, y] = projected(point).map(Math.round);
			for (let dy = -radius; dy <= radius; dy++)
				for (let dx = -radius; dx <= radius; dx++) {
					const px = x + dx,
						py = y + dy;
					if (px < 0 || px >= 256 || py < 0 || py >= 192) continue;
					const i = (py * 256 + px) * 4;
					if (pixels[i + 3] > 0 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 40)
						return true;
				}
			return false;
		};
		const pixels = await render();
		assert.ok(visible(pixels) > 15, `${shape} depth-only surface keeps its real trail visible`);
		assert.ok(visible(pixels, true) > 15, `${shape} short sampled trail depth-tests above shell`);
		const head = model.add(
			position,
			model.scale(model.worldNormal(scene.world, position), scene.species[0].size * 0.12)
		);
		assert.ok(near(await render({ vertices: 6 }), head), `${shape} head attaches to live particle`);
		assert.ok(
			visible(await render({ bodyVisible: true }), true) > visible(pixels, true),
			`${shape} body rendered with surface normal`
		);
		if (shape === 'plane') {
			const jump = packing.packParticles([agent([-3.8, 0, 0])], scene, 1);
			data.buffers.particles[0].write(jump);
			records.set([3.8, 0, 0, 1], 63 * 4);
			data.buffers.history.write(records);
			scene.world.boundaries = 'periodic';
			data.configure({ historyHead: 63, validHistory: 1, historyElapsed: 0.04 });
			assert.equal(
				visible(await render({ shellVisible: false, vertices: 6 })),
				0,
				'periodic plane jump never draws across the rectangle'
			);
			scene.world.boundaries = 'reflect';
			data.configure({ historyHead: 63, validHistory: 1, historyElapsed: 0.04 });
			assert.ok(
				visible(await render({ shellVisible: false, vertices: 6 })) > 50,
				'same reflecting-plane history remains valid'
			);
		} else {
			// The short path passes continuously through azimuth π; it must stay at
			// the visible cylinder mantle, rather than treating ±π as a jump.
			assert.ok(near(pixels, [-2.036, 0.1, 0]), 'cylinder short seam-crossing ribbon has no gap');
			camera.set({ position: [0, 8, 0.1] });
			camera.lookAt([0, 0, 0]);
			const topBlock = {
				...block,
				viewProjection: camera.viewProjection,
				position: [...camera.worldPosition, 1]
			};
			shell.set({ camera: topBlock });
			trails.set({ camera: topBlock });
			const top = await render();
			assert.ok(!near(top, [0, 0, 0], 6), 'cylinder short trail never crosses world center');
		}
		console.log(
			`PASS ${shape} native production render: bounded shell, tangent body, current head and coherent sampled histories`
		);
	});
}

try {
	await verifyGeometryRepresentatives();
	for (const shape of ['plane', 'cylinder']) {
		for (const [suffix, fixture] of [
			['random', randomCase(shape)],
			['dense', denseCase(shape)]
		])
			await verifyMeasurements(`${shape} ${suffix}`, fixture.scene, fixture.agents);
		if (shape === 'plane') {
			const fixture = randomCase(shape, true);
			// Explicit corner crossings also exercise partial-width edge cells.
			fixture.agents.splice(
				0,
				4,
				agent([5.04, 0, 4.64], [1, 0, 0], 1),
				agent([-5.04, 0, -4.64], [0, 0, 1], 2),
				agent([5.04, 0, -4.64], [-1, 0, 0], 3),
				agent([-5.04, 0, 4.64], [0, 0, -1], 4)
			);
			await verifyMeasurements(
				'plane periodic partial-edge/corner seams',
				fixture.scene,
				fixture.agents
			);
		}
		await verifyFreeMotion(shape);
		await verifyLargeSteps(shape);
		if (shape === 'plane') await verifyLargeSteps(shape, true);
		await verifyInteractions(shape);
		await verifyObstaclesAndFields(shape);
		await verifyRendering(shape);
	}
	await gpu.gpu.queue.onSubmittedWorkDone();
	assert.deepEqual(errors, [], 'surface probes have no uncaptured GPU errors');
	console.log('All plane/cylinder production GPU surface probes passed.');
} finally {
	gpu.dispose();
	if (!previousShaderStage) delete globalThis.GPUShaderStage;
}
