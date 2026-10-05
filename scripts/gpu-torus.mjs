import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, compute, draw, frame, target } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

// Native torus gate: Float32 midpoint geometry vs chart and shooting references.
// No benchmark timings: this is correctness validation against independent CPU
// geometry/measurement oracles and actual depth-tested production rendering.
const require = createRequire(import.meta.url);
const packagePath = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [packagePath] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing, createComputeRuntime, reference;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	reference = await vite.ssrLoadModule('/src/lib/model/torus-reference.ts');
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
const length = model.magnitude;
function sceneFor(ratio = 3, radius = 4) {
	const scene = model.createDefaultScene();
	scene.world = {
		kind: 'surface',
		shape: 'torus',
		majorRadius: ratio * radius,
		tubeRadius: radius
	};
	scene.seed = 0xc37ae19b;
	scene.dynamics.fixedDt = 1 / 60;
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.dynamics.metricSmoothingSeconds = 0;
	scene.forces.enabled = false;
	scene.forces.radius = radius * 0.2;
	scene.obstacles = [];
	scene.speciesRules = [];
	scene.species.forEach((s, i) => {
		s.key = i ? 'neighbor' : 'observer';
		s.population = 1;
		s.size = radius * 0.015;
		s.speed = radius * 2;
		s.cruiseSpeed = 0;
		s.force = radius * 2;
		s.perception = radius * (0.2 + i * 0.025);
		s.alignment = 0;
		s.cohesion = 0;
		s.separation = 0;
		s.rebels.fraction = 0;
		s.metricRules = [];
		s.cursor.response = 'ignore';
		s.cursor.vortex = 0;
		s.trail = { length: 2, width: radius * 0.06, opacity: 1 };
		s.visual.hsl = [0.12, 0.85, 0.65];
		for (const c of ['hue', 'saturation', 'lightness']) s.visual[c].enabled = false;
	});
	return scene;
}
const agent = (position, velocity = [0, 0, 0], id = 1, speciesKey = 'observer') => ({
	id,
	birth: id,
	speciesKey,
	position,
	velocity
});
const params = (world) => ({ majorRadius: world.majorRadius, tubeRadius: world.tubeRadius });
const normError = (a, b) => length(model.subtract(a, b));
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

async function verifyFloat32Geometry() {
	const symbol = (name) => {
		const match = sources.common.match(new RegExp(`fn\\s+(\\w+__${name})\\s*\\(`));
		assert.ok(match, `resolved ${name}`);
		return match[1];
	};
	const shader = `${sources.common}
 @group(0) @binding(0) var<storage,read> input:array<vec4f>;
 @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
 @compute @workgroup_size(128) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&input)/4u){return;}
 let p=input[id.x*4u];let q=input[id.x*4u+1u];let v=input[id.x*4u+2u].xyz;let d=input[id.x*4u+3u].xyz;
 let relation=${symbol('torus_relation')}(p.xyz,q.xyz,p.w,q.w);
 let motion=${symbol('torus_motion')}(p.xyz,d,v,v,p.w,q.w);
 result[id.x*7u]=vec4f(relation.displacement,relation.distance);
 result[id.x*7u+1u]=vec4f(${symbol('torus_transport')}(v,p.xyz,q.xyz,q.w),relation.angle);
 result[id.x*7u+2u]=vec4f(motion.position,0.0);
 result[id.x*7u+3u]=vec4f(motion.velocity,0.0);
 result[id.x*7u+4u]=vec4f(motion.previousVelocity,0.0);
 result[id.x*7u+5u]=vec4f(${symbol('torus_offset')}(p.xyz,d,p.w,q.w),0.0);
 result[id.x*7u+6u]=vec4f(${symbol('world_normal')}(p.xyz,4.0,q.w),0.0);
 }`;
	const fixtures = [];
	for (const ratio of [2, 3, 5, 10])
		for (const radius of [1, 10, 1000])
			for (const theta of [
				-Math.PI + 0.015,
				-2.2,
				-Math.PI / 2,
				-0.7,
				0,
				0.7,
				Math.PI / 2,
				Math.PI - 0.015
			])
				for (const phi of [-Math.PI + 0.015, 0.7, Math.PI - 0.015])
					for (let direction = 0; direction < 6; direction++)
						for (const fraction of [0.03, 0.15, 0.295]) {
							const world = { majorRadius: ratio * radius, tubeRadius: radius };
							const from = { theta, phi };
							const components = [
								radius * fraction * Math.cos((direction * Math.PI) / 3),
								radius * fraction * Math.sin((direction * Math.PI) / 3)
							];
							const to = model.torusLocalPoint(world, from, components);
							fixtures.push({
								world,
								p: model.torusPoint(world, from),
								q: model.torusPoint(world, to),
								v: model.torusWorldVector(from, [0.3 * radius, 0.2 * radius]),
								d: model.torusWorldVector(from, components)
							});
						}
	const words = new Float32Array(fixtures.length * 16);
	fixtures.forEach((c, i) =>
		words.set(
			[...c.p, c.world.tubeRadius, ...c.q, c.world.majorRadius, ...c.v, 0, ...c.d, 0],
			i * 16
		)
	);
	const input = gpu.device.createBuffer({ size: words.byteLength, usage: ['storage', 'copy_dst'] });
	const result = gpu.device.createBuffer({
		size: fixtures.length * 7 * 16,
		usage: ['storage', 'copy_src']
	});
	const maxima = {
		distance: 0,
		displacement: 0,
		transport: 0,
		motion: 0,
		offset: 0,
		shootingDistance: 0,
		shootingDirection: 0,
		shootingTransport: 0
	};
	let shootings = 0;
	try {
		input.write(words);
		compute(gpu, shader, { entry: 'probe', set: { input, result } }).dispatch(
			Math.ceil(fixtures.length / 128)
		);
		const values = new Float32Array(await result.read(fixtures.length * 7 * 16));
		for (let i = 0; i < fixtures.length; i++) {
			const { world } = fixtures[i],
				r = world.tubeRadius;
			const p = [...words.subarray(i * 16, i * 16 + 3)],
				q = [...words.subarray(i * 16 + 4, i * 16 + 7)],
				v = [...words.subarray(i * 16 + 8, i * 16 + 11)],
				d = [...words.subarray(i * 16 + 12, i * 16 + 15)];
			const from = model.torusChart(world, p),
				to = model.torusChart(world, q);
			const relation = model.torusApproximateRelation(world, from, to);
			const displacement = model.torusWorldVector(from, relation.displacement);
			const row = (n) => [...values.subarray((i * 7 + n) * 4, (i * 7 + n) * 4 + 3)];
			const distanceError = Math.abs(values[i * 28 + 3] - relation.distance) / r;
			const displacementError = normError(row(0), displacement) / r;
			assert.ok(distanceError < 8e-6, `Float32 midpoint distance ${i}: ${distanceError}r`);
			assert.ok(displacementError < 9e-6, `Float32 local log ${i}: ${displacementError}r`);
			maxima.distance = Math.max(maxima.distance, distanceError);
			maxima.displacement = Math.max(maxima.displacement, displacementError);
			const transported = model.torusWorldVector(
				to,
				model.torusRotate(model.torusComponents(from, v), relation.transportAngle)
			);
			const transportError = normError(row(1), transported) / r;
			assert.ok(transportError < 7e-6, `Float32 chart transport ${i}: ${transportError}r`);
			maxima.transport = Math.max(maxima.transport, transportError);
			close(values[i * 28 + 7], relation.transportAngle, `native connection angle ${i}`, 8e-6);
			const motion = model.torusAdvanceWorld(world, p, d, 1, v);
			const motionError = normError(row(2), motion.position) / r;
			assert.ok(motionError < 1.2e-5, `Float32 midpoint physical motion ${i}: ${motionError}r`);
			assert.ok(
				normError(row(3), motion.transportedPriorVelocity) / r < 8e-6,
				`actual-path velocity transport ${i}`
			);
			assert.deepEqual(
				row(3),
				row(4),
				'identical candidate and previous vectors follow identical path rotation'
			);
			maxima.motion = Math.max(maxima.motion, motionError);
			const expectedOffset = model.torusPoint(
				world,
				model.torusLocalPoint(world, from, model.torusComponents(from, d))
			);
			const offsetError = normError(row(5), expectedOffset) / r;
			assert.ok(offsetError < 1.2e-5, `Float32 inverse midpoint log ${i}: ${offsetError}r`);
			maxima.offset = Math.max(maxima.offset, offsetError);
			assert.ok(
				normError(row(6), model.torusNormal(from)) < 8e-6,
				'native normal is the actual tube normal'
			);
			if (i % 16 === 0) {
				const exact = reference.torusReferenceRelation(world, from, to);
				const gpuComponents = model.torusComponents(from, row(0));
				const directionError = Math.abs(
					model.torusShortAngle(
						Math.atan2(gpuComponents[1], gpuComponents[0]) -
							Math.atan2(exact.displacement[1], exact.displacement[0])
					)
				);
				const relativeDistance = Math.abs(values[i * 28 + 3] - exact.distance) / exact.distance;
				const angleError = Math.abs(values[i * 28 + 7] - exact.transportAngle);
				assert.ok(relativeDistance < 0.0017, `shooting distance ${i}: ${relativeDistance}`);
				assert.ok(directionError < 0.004, `shooting direction ${i}: ${directionError} rad`);
				assert.ok(angleError < 0.001, `shooting transport ${i}: ${angleError} rad`);
				maxima.shootingDistance = Math.max(maxima.shootingDistance, relativeDistance);
				maxima.shootingDirection = Math.max(maxima.shootingDirection, directionError);
				maxima.shootingTransport = Math.max(maxima.shootingTransport, angleError);
				shootings++;
			}
		}
		console.log(
			`PASS ${fixtures.length} native Float32 torus relations/motion/offsets, R/r2..10 and r1..1000; ${shootings} shooting comparisons; observed maxima ${JSON.stringify(maxima)}`
		);
	} finally {
		input.destroy();
		result.destroy();
	}
}
async function verifyMeasurements(name, scene, agents) {
	await withCase(scene, agents, async (data) => {
		const actual = await data.measured();
		const expected = model.measureAllPairs(scene, data.canonical);
		const indices = new Uint32Array(await data.buffers.indices.read(agents.length * 4));
		assert.deepEqual(
			[...indices].sort((a, b) => a - b),
			agents.map((_, i) => i),
			'complete torus scatter'
		);
		for (let i = 0; i < agents.length; i++)
			for (let f = 0; f < packing.METRIC_ORDER.length; f++) {
				const key = packing.METRIC_ORDER[f];
				let error = Math.abs(actual[i * METRIC_STRIDE + f] - expected[i][key]);
				if (circularFields.has(key)) error = Math.min(error, 1 - error);
				const tolerance =
					f === 3
						? 0
						: tolerances[f] +
							(f === 4 ? Math.abs(expected[i][key]) * 3e-6 : 0) +
							(f === 9 ? scene.world.tubeRadius * 7e-6 : 0) +
							// Radial speed normalizes the mean local displacement.
							// For centroid length d and displacement error e, unit
							// direction error is bounded by 2e/d. Use the existing
							// Float32 torus spatial budget, including near-centroid
							// conditioning rather than a uniform speed tolerance.
							(f === 13
								? (2 * expected[i].speed * scene.world.tubeRadius * 7e-6) /
									Math.max(expected[i].centerDistance, 1e-7)
								: 0);
				assert.ok(
					Number.isFinite(actual[i * METRIC_STRIDE + f]) && error <= tolerance,
					`${name} ${key}[${i}]: ${actual[i * METRIC_STRIDE + f]} vs ${expected[i][key]}, error ${error}`
				);
			}
		console.log(
			`PASS ${name}: complete ${agents.length}-agent neighbors and all 15 CPU midpoint-classifier measurements`
		);
	});
}
function cluster(scene, theta, phi, count = 145) {
	const surface = params(scene.world),
		from = { theta, phi },
		r = surface.tubeRadius;
	return Array.from({ length: count }, (_, i) => {
		const a = i * 2.3999632297,
			distance = r * (0.015 + (i % 19) * 0.003);
		const chart = model.torusLocalPoint(surface, from, [
			distance * Math.cos(a),
			distance * Math.sin(a)
		]);
		return agent(
			model.torusPoint(surface, chart),
			model.torusWorldVector(chart, [r * (0.7 + 0.1 * Math.cos(i)), r * 0.2 * Math.sin(i)]),
			i + 1,
			i % 2 ? 'observer' : 'neighbor'
		);
	});
}
async function verifyFreeMotion(ratio, theta, phi) {
	const scene = sceneFor(ratio);
	scene.species.forEach((s) => (s.force = 0));
	const surface = params(scene.world),
		start = { theta, phi },
		v = [0.7, 1.0];
	const initial = agent(model.torusPoint(surface, start), model.torusWorldVector(start, v));
	await withCase(scene, [initial], async (data) => {
		const from = model.torusChart(surface, data.canonical[0].position);
		let expected = { position: data.canonical[0].position, velocity: data.canonical[0].velocity };
		for (let i = 0; i < 180; i++) {
			expected = model.worldAdvance(
				scene.world,
				expected.position,
				expected.velocity,
				scene.dynamics.fixedDt,
				0,
				expected.velocity
			);
			data.step();
		}
		const { agents, bytes } = await data.state();
		const actual = agents[0];
		assert.ok(
			normError(actual.position, expected.position) < surface.tubeRadius * 1.2e-4,
			`torus accumulated Float32 position ratio${ratio}`
		);
		assert.ok(
			normError(actual.velocity, expected.velocity) < surface.tubeRadius * 5e-5,
			'torus accumulated Float32 velocity'
		);
		const exact = reference.torusIntegrateReference(
			surface,
			{ ...from, velocity: model.torusComponents(from, data.canonical[0].velocity) },
			180 * scene.dynamics.fixedDt,
			2400
		);
		assert.ok(
			normError(actual.position, model.torusPoint(surface, exact)) / surface.tubeRadius < 2e-4,
			'midpoint free motion vs RK4'
		);
		close(
			length(actual.velocity),
			length(data.canonical[0].velocity),
			'conserved torus free speed',
			7e-5
		);
		close(
			model.dot(model.worldNormal(scene.world, actual.position), actual.velocity),
			0,
			'torus tangent velocity',
			5e-6
		);
		const metrics = await data.measured();
		close(metrics[1], 0, 'free covariant turn', 3e-4);
		close(metrics[2], 0, 'free covariant acceleration', 4e-4);
		const floats = new Float32Array(bytes);
		assert.ok(
			normError(actual.velocity, [...floats.subarray(8, 11)]) < 1e-5,
			'stored prior transported along actual path'
		);
	});
	console.log(
		`PASS torus R/r${ratio}:180 free ticks from θ${theta.toFixed(2)}/φ${phi.toFixed(2)}, RK4 agreement, speed/tangency and actual-path zero derivatives`
	);
}
function pair(scene, distance = 0.06 * scene.world.tubeRadius) {
	const surface = params(scene.world),
		from = { theta: 0.4, phi: 0.7 },
		r = surface.tubeRadius;
	const to = model.torusLocalPoint(surface, from, [0, distance]);
	return [
		agent(model.torusPoint(surface, from)),
		agent(model.torusPoint(surface, to), model.torusWorldVector(to, [0.4 * r, 0]), 2, 'neighbor')
	];
}
async function verifyBehaviors() {
	const results = {};
	for (const behavior of model.BEHAVIORS) {
		const scene = sceneFor();
		scene.speciesRules = [
			{
				id: behavior,
				from: 'observer',
				to: 'neighbor',
				behavior,
				strength: 1,
				radius: scene.world.tubeRadius * 0.24
			}
		];
		const initial = pair(scene);
		await withCase(scene, initial, async (data) => {
			data.step();
			const [state] = (await data.state()).agents;
			const origin = model.torusChart(params(scene.world), initial[0].position);
			const back = model.worldTransport(
				scene.world,
				state.velocity,
				state.position,
				initial[0].position
			);
			const [heading, toward] = model.torusComponents(origin, back);
			results[behavior] = { heading, toward, magnitude: length(back) };
			close(
				model.dot(state.velocity, model.worldNormal(scene.world, state.position)),
				0,
				`${behavior} tangent`,
				1e-5
			);
			assert.ok(
				length(state.velocity) <= scene.species[0].force * scene.dynamics.fixedDt + 2e-5,
				'steering force bound'
			);
		});
	}
	const positive = (v, key) => assert.ok(v > 1e-4, `${key}: ${v}`),
		negative = (v, key) => assert.ok(v < -1e-4, `${key}: ${v}`);
	close(results.ignore.magnitude, 0, 'Ignore');
	negative(results.flee.toward, 'Flee');
	positive(results.chase.toward, 'Chase');
	positive(results.chase.heading, 'Chase lead');
	positive(results.cohere.toward, 'Cohere');
	positive(results.align.heading, 'Align');
	negative(results.orbit.heading, 'Orbit');
	positive(results.follow.toward, 'Follow');
	negative(results.follow.heading, 'Follow behind');
	negative(results.guard.toward, 'Guard');
	negative(results.disperse.toward, 'Disperse');
	positive(results.mob.toward, 'Mob');
	negative(results.mirror.heading, 'Mirror');
	positive(results.spiral.toward, 'Spiral');
	for (const same of [false, true]) {
		const scene = sceneFor();
		scene.dynamics.collision = 1;
		const point = pair(scene)[0].position;
		await withCase(
			scene,
			[agent(point), agent(point, [0, 0, 0], 2, same ? 'observer' : 'neighbor')],
			async (data) => {
				data.step();
				const { agents, bytes } = await data.state();
				assert.ok(new Float32Array(bytes).slice(0, 12).every(Number.isFinite));
				assert.ok(
					length(model.worldDisplacement(scene.world, agents[0].position, agents[1].position)) >
						0.008 * scene.world.tubeRadius,
					'coincident intrinsic contact separation'
				);
				agents.forEach((a) =>
					assert.ok(
						length(a.velocity) <= scene.species[0].force * scene.dynamics.fixedDt + 1e-5,
						'bounded contact steering'
					)
				);
			}
		);
	}
	const scene = sceneFor();
	scene.species.forEach((s) => (s.perception = 0.06 * scene.world.tubeRadius));
	scene.speciesRules = [
		{
			id: 'long',
			from: 'observer',
			to: '*',
			behavior: 'flee',
			strength: 1,
			radius: 0.27 * scene.world.tubeRadius
		}
	];
	await withCase(scene, pair(scene, 0.23 * scene.world.tubeRadius), async (data) => {
		data.step();
		assert.ok(
			length((await data.state()).agents[0].velocity) > 1e-4,
			'long per-source torus query'
		);
	});
	console.log(
		'PASS torus: all 12 tangent behavior semantics, coincident same/cross contacts and long per-source query'
	);
}
async function verifyObstaclesForces() {
	const scene = sceneFor(),
		p = pair(scene)[0].position,
		r = scene.world.tubeRadius;
	scene.obstacles = [{ id: 'disk', shape: 'sphere', center: p, radius: 0.06 * r }];
	scene.obstacleSettings.enabled = true;
	scene.species[0].force = 0;
	await withCase(scene, [agent(p)], async (data) => {
		data.step();
		const [a] = (await data.state()).agents;
		close(
			length(model.worldDisplacement(scene.world, p, a.position)),
			0.075 * r,
			'classifier-consistent torus obstacle projection',
			r * 1e-5
		);
	});
	const fieldScene = sceneFor();
	fieldScene.forces.enabled = true;
	fieldScene.species[0].cursor.response = 'attract';
	fieldScene.species[0].cursor.strength = 1;
	const destination = pair(fieldScene, 0.1 * r)[1].position;
	await withCase(fieldScene, [agent(p)], async (data) => {
		data.step({ field: { position: destination, active: true, pressed: false } });
		const [a] = (await data.state()).agents;
		assert.ok(length(a.velocity) > 1e-4, 'intrinsic torus force');
		close(
			model.dot(a.velocity, model.worldNormal(scene.world, a.position)),
			0,
			'torus field tangent',
			1e-5
		);
	});
	console.log('PASS torus: inverse midpoint-log obstacle boundary and actual tangent force field');
}
async function verifyRendering(ratio) {
	const scene = sceneFor(ratio, 1);
	scene.species = [scene.species[0]];
	scene.species[0].size = 0.05;
	scene.species[0].trail.width = 0.09;
	const surface = params(scene.world),
		angular = 1 / (ratio - 1);
	const charts = [
		{ theta: Math.PI + 0.06, phi: Math.PI + 0.012 * angular },
		{ theta: Math.PI + 0.025, phi: Math.PI + 0.004 * angular },
		{ theta: Math.PI - 0.025, phi: Math.PI - 0.004 * angular },
		{ theta: Math.PI - 0.06, phi: Math.PI - 0.012 * angular }
	];
	const points = charts.map((c) => model.torusPoint(surface, c));
	await withCase(scene, [agent(points[0])], async (data) => {
		const output = target(gpu, { size: [256, 192], format: 'rgba8unorm', depth: true });
		const camera = perspectiveCamera({
			fov: ratio === 2 ? 55 : 25,
			aspect: 4 / 3,
			position: [0, 0, 0],
			target: [-(ratio - 1), 0, 0],
			near: 0.01,
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
			vertices: 55296,
			depth: { write: true },
			set: { config: data.buffers.config, camera: block }
		});
		const grid = draw(gpu, {
			shader: sources.world,
			vertices: 13824,
			blend: 'alpha',
			depth: { write: false },
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
		const force = draw(gpu, {
			shader: sources.world,
			entry: { vertex: 'vs_force', fragment: 'fs_force' },
			vertices: 1536,
			blend: 'premultiplied',
			depth: { write: false, compare: 'less-equal' },
			set: { config: data.buffers.config, camera: block }
		});
		const obstacle = draw(gpu, {
			shader: sources.world,
			entry: { vertex: 'vs_obstacles', fragment: 'fs_obstacles' },
			vertices: 10800,
			depth: { write: true },
			set: { config: data.buffers.config, camera: block }
		});
		const records = new Float32Array(256);
		for (let slot = 0; slot < 64; slot++) records.set([...points[1], 1], slot * 4);
		points.slice(1).forEach((p, i) => records.set([...p, 1], (63 - i) * 4));
		data.buffers.history.write(records);
		const configure = () =>
			data.configure({
				historyHead: 63,
				validHistory: 3,
				historyElapsed: 0.015,
				sampleHistory: false,
				field: {
					position: model.torusPoint(surface, { theta: Math.PI, phi: Math.PI }),
					active: true,
					pressed: false
				}
			});
		configure();
		const render = async ({
			bodyVisible = false,
			gridVisible = false,
			field = false,
			disk = false,
			trail = true
		} = {}) => {
			const submitted = frame(gpu, (f) =>
				f.pass({ target: output, clear: [0, 0, 0, 0], clearDepth: 1 }, (pass) => {
					pass.draw(shell);
					if (gridVisible) pass.draw(grid);
					if (trail) pass.draw(trails, { instances: 1 });
					if (bodyVisible) pass.draw(body, { instances: 1 });
					if (field) pass.draw(force);
					if (disk) pass.draw(obstacle, { instances: 1 });
				})
			);
			await Promise.all([submitted.done, gpu.gpu.queue.onSubmittedWorkDone()]);
			return output.color.read({ mipLevel: 0, region: 'all' });
		};
		const bright = (pixels) => {
			let count = 0;
			for (let i = 0; i < pixels.length; i += 4)
				if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 40) count++;
			return count;
		};
		const project = (point) => {
			const m = camera.viewProjection;
			const c = [0, 1, 2, 3].map(
				(row) => m[row] * point[0] + m[4 + row] * point[1] + m[8 + row] * point[2] + m[12 + row]
			);
			return [((c[0] / c[3]) * 0.5 + 0.5) * 256, (0.5 - (c[1] / c[3]) * 0.5) * 192];
		};
		const near = (pixels, p, radius = 3) => {
			const [x, y] = project(p).map(Math.round);
			for (let dy = -radius; dy <= radius; dy++)
				for (let dx = -radius; dx <= radius; dx++) {
					const px = x + dx,
						py = y + dy;
					if (px < 0 || px >= 256 || py < 0 || py >= 192) continue;
					const i = (py * 256 + px) * 4;
					if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 40) return true;
				}
			return false;
		};
		const pixels = await render();
		assert.ok(bright(pixels) > 6, `ratio${ratio} inner-ring depth-tested ribbon visible`);
		const seam = model.torusPoint(surface, { theta: Math.PI, phi: Math.PI });
		const lifted = model.add(
			seam,
			model.scale(model.torusNormal({ theta: Math.PI, phi: Math.PI }), 0.006)
		);
		assert.ok(near(pixels, lifted), 'short torus histories cross both chart seams without a gap');
		assert.ok(
			bright(await render({ bodyVisible: true })) > bright(pixels),
			'torus normal-oriented body visible'
		);
		assert.ok(
			bright(await render({ gridVisible: true })) >= bright(pixels),
			'torus wire grid compiles with actual chart geometry'
		);
		scene.forces.enabled = true;
		scene.forces.radius = 0.16;
		configure();
		assert.ok(
			bright(await render({ field: true, trail: false })) > 8,
			'classifier-consistent torus force-radius contour visible'
		);
		scene.obstacleSettings.enabled = true;
		scene.obstacles = [{ id: 'visible', shape: 'sphere', center: seam, radius: 0.02 }];
		configure();
		const plain = await render({ trail: false }),
			disk = await render({ disk: true, trail: false });
		assert.ok(
			disk.some((value, i) => value !== plain[i]),
			'intrinsic torus obstacle disk renders above inner shell'
		);
		console.log(
			`PASS torus R/r${ratio} native inner-ring render: shell/grid, bodies, histories across both seams, force contour and obstacle disk`
		);
	});
}
try {
	await verifyFloat32Geometry();
	for (const ratio of [2, 3, 5, 10]) {
		const scene = sceneFor(ratio);
		scene.species.forEach((s, i) => (s.population = 71 + i * 13));
		await verifyMeasurements(
			`torus R/r${ratio} uniform`,
			scene,
			model.initializePopulation(scene).agents
		);
		for (const [theta, phi, name] of [
			[0.7, 0.9, 'dense'],
			[Math.PI - 0.015, Math.PI - 0.015, 'both seams'],
			[Math.PI / 2, Math.PI - 0.01, 'tube top']
		])
			await verifyMeasurements(`torus R/r${ratio} ${name}`, scene, cluster(scene, theta, phi));
	}
	for (const ratio of [2, 10]) {
		await verifyFreeMotion(ratio, Math.PI - 0.01, Math.PI - 0.01);
		await verifyFreeMotion(ratio, 0.6, 1.1);
		await verifyRendering(ratio);
	}
	await verifyBehaviors();
	await verifyObstaclesForces();
	await gpu.gpu.queue.onSubmittedWorkDone();
	assert.deepEqual(errors, [], 'no uncaptured torus GPU errors');
	console.log('All native torus geometry, physics, metrics, behavior and render gates passed.');
} finally {
	gpu.dispose();
	if (!previousShaderStage) delete globalThis.GPUShaderStage;
}
