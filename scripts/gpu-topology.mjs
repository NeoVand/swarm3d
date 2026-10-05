import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { init, compute } from 'vgpu/node';

// Actual production WGSL and prefix/scatter neighborhoods on the four new
// worlds. The reference is the declared local polyhedral classifier, not a
// claim that centroid-path unfolding is an exact smooth-surface logarithm.
const require = createRequire(import.meta.url);
const packagePath = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [packagePath] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model,
	packing,
	topologyPacking,
	meshModel,
	relationModel,
	createComputeRuntime,
	findSurfaceIntersections;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
	topologyPacking = await vite.ssrLoadModule('/src/lib/gpu/topology.ts');
	meshModel = await vite.ssrLoadModule('/src/lib/model/topology-mesh.ts');
	relationModel = await vite.ssrLoadModule('/src/lib/model/topology-relations.ts');
	({ findSurfaceIntersections } = await vite.ssrLoadModule(
		'/scripts/helpers/topology-fixtures.ts'
	));
	({ createComputeRuntime } = await vite.ssrLoadModule('/src/lib/gpu/compute-runtime.ts'));
} finally {
	await vite.close();
}
const shapes = ['mobius', 'klein', 'projective', 'trefoil'];
const shaders = Object.fromEntries(
	await Promise.all(
		Object.entries({
			grid: 'grid',
			simulation: 'simulate',
			metrics: 'metrics',
			history: 'history'
		}).map(async ([key, file]) => [
			key,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${file}.wgsl`) })).wgsl
		])
	)
);
await mkdir('.cache', { recursive: true });
await writeFile(
	'.cache/topology-native-probe.wgsl',
	`
import { topology_walk, topology_relation } from "../src/lib/gpu/shaders/topology.wgsl";
@group(0) @binding(0) var<storage,read> config:array<vec4f>;
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(128) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&input)/6u){return;}
 let i=id.x*6u;
 let motion=topology_walk(&config,input[i],input[i+1u].w,input[i+1u].xyz,input[i+2u].xyz,input[i+3u].xyz);
 result[i]=motion.position;result[i+1u]=motion.velocity;
 result[i+2u]=vec4f(motion.previousVelocity,select(0.0,1.0,motion.complete));
 let relation=topology_relation(&config,input[i],input[i+4u],input[i+5u].xyz);
 result[i+3u]=vec4f(relation.displacement,relation.distance);
 result[i+4u]=vec4f(relation.velocity,select(0.0,1.0,relation.valid));
 result[i+5u]=vec4f(0.0);
}`
);
const probeSource = (await resolveShader({ entry: resolve('.cache/topology-native-probe.wgsl') }))
	.wgsl;
const gpu = await init({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
const originalShaderStage = globalThis.GPUShaderStage;
if (!originalShaderStage)
	Object.defineProperty(globalThis, 'GPUShaderStage', {
		value: Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }),
		configurable: true
	});
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const add = (a, b) => a.map((value, axis) => value + b[axis]);
const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const scale = (a, factor) => a.map((value) => value * factor);
const length = (value) => Math.hypot(...value);
const unit = (value) => scale(value, 1 / Math.max(1e-20, length(value)));
const dot = (a, b) => a.reduce((value, v, axis) => value + v * b[axis], 0);
const cross = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];
const close = (a, b, label, tolerance) =>
	assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} != ${b} (${tolerance})`);
const vectorClose = (a, b, label, tolerance) =>
	a.forEach((value, axis) => close(value, b[axis], `${label}[${axis}]`, tolerance));
const circular = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
const metricsFields = [
	'speed',
	'turnRate',
	'acceleration',
	'neighborCount',
	'density',
	'anisotropy',
	'polarization',
	'radialFlow',
	'headingAzimuth',
	'centerDistance',
	'centerBearing',
	'flowOrbit',
	'centerOrbitAngle',
	'centerRadialSpeed',
	'speedContrast'
];
let runtime;
function sceneFor(shape, population = 80) {
	const scene = model.createDefaultScene();
	scene.world = { kind: 'surface', shape, radius: 14 };
	scene.seed = 0x4c039daa;
	scene.forces.enabled = false;
	scene.forces.radius = 1;
	scene.speciesRules = [];
	scene.obstacles = [];
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.dynamics.metricSmoothingSeconds = 0;
	scene.species.forEach((species, i) => {
		species.population = i ? Math.floor(population / 2) : Math.ceil(population / 2);
		species.speed = 2.8;
		species.cruiseSpeed = 0;
		species.force = 0;
		species.perception = i ? 1.42 : 0.91;
		species.size = 0.02;
		species.alignment = 0;
		species.cohesion = 0;
		species.separation = 0;
		species.rebels.fraction = 0;
		species.metricRules = [];
		species.cursor.response = 'ignore';
		species.cursor.vortex = 0;
	});
	return scene;
}
function packedConfig(scene, count, options = {}) {
	const prefix = packing.packConfig(scene, {
		population: count,
		tick: 0,
		historyHead: 0,
		validHistory: 1,
		smoothingAlpha: 1,
		...options
	});
	const topology = topologyPacking.packTopology(scene);
	const prefixLength = (16 + 2 * scene.obstacles.length) * 4;
	const result = new Float32Array(prefixLength + topology.length);
	result.set(prefix.subarray(0, prefixLength));
	result.set(topology, prefixLength);
	return result;
}
async function withBuffers(scene, agents, action) {
	const grid = packing.gridDefinition(scene),
		count = agents.length;
	const data = packedConfig(scene, count);
	const owned = [];
	const allocate = (label, size) => {
		const result = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(result);
		return result;
	};
	const buffers = {
		config: allocate('topology config and immutable atlas', data.byteLength),
		particles: [
			allocate('topology particles A', count * packing.PARTICLE_BYTES),
			allocate('topology particles B', count * packing.PARTICLE_BYTES)
		],
		metrics: [
			allocate('topology metrics A', count * packing.METRIC_BYTES),
			allocate('topology metrics B', count * packing.METRIC_BYTES)
		],
		history: allocate(
			'tagged topology trajectories',
			count * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES
		),
		grid: allocate('complete topology grid', (grid.count * 3 + 1) * 4),
		indices: allocate('topology membership', count * 4),
		blocks: allocate('topology prefix blocks', Math.ceil(grid.count / 256) * 4),
		species: allocate('topology species', scene.species.length * packing.SPECIES_ROWS * 16),
		pairRules: allocate('topology rules', scene.species.length ** 2 * 16)
	};
	try {
		buffers.config.write(data);
		const bytes = packing.packParticles(agents, scene, 1);
		const words = new Float32Array(bytes);
		agents.forEach((agent, i) => {
			assert.equal(words[i * 16 + 3], agent.triangle + 1, `${scene.world.shape} packed face tag`);
			assert.equal(words[i * 16 + 7], agent.orientation ?? 1, 'packed orientation');
		});
		buffers.particles.forEach((buffer) => buffer.write(bytes));
		buffers.species.write(packing.packSpecies(scene));
		buffers.pairRules.write(packing.packPairRules(scene));
		if (!runtime) runtime = await createComputeRuntime(gpu, shaders, buffers);
		else runtime.rebind(buffers);
		let side = 0,
			metricSide = 0,
			tick = 0;
		const configure = (options = {}) => {
			// The atlas is immutable. Match the production hot prefix upload.
			buffers.config.write(
				packing.packConfig(
					scene,
					{
						population: count,
						tick,
						historyHead: tick % 64,
						validHistory: Math.min(63, tick + 1),
						smoothingAlpha: 1,
						...options
					},
					undefined,
					new Float32Array((16 + 2 * scene.obstacles.length) * 4)
				)
			);
		};
		await action({
			buffers,
			grid,
			words,
			configure,
			bootstrap() {
				configure();
				runtime.bootstrap(side, metricSide, count, grid.count);
				metricSide = 1 - metricSide;
			},
			step(options = {}) {
				tick++;
				configure(options);
				runtime.tick(side, metricSide, count, grid.count, packing.HISTORY_SAMPLES);
				side = 1 - side;
				metricSide = 1 - metricSide;
			},
			async state() {
				return new Float32Array(await buffers.particles[side].read(count * packing.PARTICLE_BYTES));
			},
			async measure() {
				return new Float32Array(
					await buffers.metrics[metricSide].read(count * packing.METRIC_BYTES)
				);
			}
		});
	} finally {
		owned.forEach((buffer) => buffer.destroy());
	}
}
function canonicalAgents(scene, words) {
	return packing.unpackParticles(words.buffer, scene, words.length / 16);
}
function referenceMetrics(scene, mesh, table, agents, index) {
	const self = agents[index],
		radius = Math.fround(scene.species.find((s) => s.key === self.speciesKey).perception);
	const relations = [];
	agents.forEach((other, i) => {
		if (i === index) return;
		const relation = relationModel.topologyRelation(
			table,
			self.triangle,
			other.triangle,
			self.position,
			other.position,
			other.velocity
		);
		if (relation && relation.distance <= radius) relations.push(relation);
	});
	const normal = scale(mesh.normals[self.triangle], self.orientation ?? 1);
	const face = mesh.triangles[self.triangle],
		east = unit(sub(mesh.vertices[face[1]], mesh.vertices[face[0]])),
		north = cross(normal, east);
	const zero = [0, 0, 0];
	const mean = (field) =>
		relations.length ? scale(relations.map(field).reduce(add, zero), 1 / relations.length) : zero;
	const meanDelta = mean((r) => r.displacement),
		meanVelocity = mean((r) => r.velocity),
		unitVelocity = mean((r) => unit(r.velocity));
	const heading = model.bearing(self.velocity, [
		[1, 0, 0],
		[0, 0, -1]
	]);
	const covariance = Array.from({ length: 3 }, () => [0, 0, 0]);
	for (const relation of relations)
		for (let x = 0; x < 3; x++)
			for (let y = 0; y < 3; y++)
				covariance[x][y] +=
					(relation.displacement[x] * relation.displacement[y]) / relations.length;
	const trace = covariance[0][0] + covariance[1][1] + covariance[2][2];
	// For tangent displacements the third eigenvalue is zero. The closed form of
	// the two nonzero eigenvalues supplies an independent anisotropy oracle.
	let frobenius = 0;
	for (const row of covariance) for (const value of row) frobenius += value * value;
	const largest = (trace + Math.sqrt(Math.max(0, 2 * frobenius - trace * trace))) / 2;
	const anisotropy = trace > 1e-8 ? Math.max(0, Math.min(1, (2 * largest) / trace - 1)) : 0;
	const radialFlow = relations.length
		? relations.reduce(
				(sum, r) => sum + dot(unit(sub(r.velocity, self.velocity)), unit(r.displacement)),
				0
			) / relations.length
		: 0;
	const out = scale(meanDelta, -1),
		speed = length(self.velocity);
	let orbit = 0;
	if (relations.length && speed > 1e-7 && length(out) > 1e-7)
		orbit =
			(((Math.atan2(dot(cross(self.velocity, out), normal), dot(self.velocity, out)) /
				(2 * Math.PI) +
				0.5) %
				1) +
				1) %
			1;
	return [
		speed,
		0,
		0,
		relations.length,
		relations.length / (Math.PI * radius * radius),
		anisotropy,
		Math.min(1, length(unitVelocity)),
		radialFlow,
		heading,
		length(meanDelta),
		model.bearing(meanDelta, [east, north]),
		model.bearing(meanVelocity, [east, north]),
		orbit,
		dot(self.velocity, unit(meanDelta)),
		relations.length
			? Math.abs(speed - length(meanVelocity)) /
				scene.species.find((s) => s.key === self.speciesKey).speed
			: 0
	];
}
async function geometryGate(scene, mesh, table) {
	const random = model.seededRandom(0x591f238a),
		fixtures = [];
	for (let i = 0; i < 80; i++) {
		const sample = meshModel.sampleTopology(mesh, random);
		const face = mesh.triangles[sample.triangle],
			east = unit(sub(mesh.vertices[face[1]], mesh.vertices[face[0]]));
		const north = cross(mesh.normals[sample.triangle], east),
			angle = random() * 2 * Math.PI;
		const v = scale(add(scale(east, Math.cos(angle)), scale(north, Math.sin(angle))), 2.8);
		fixtures.push({
			sample,
			v,
			displacement: scale(v, 1 / 60),
			other: meshModel.sampleTopology(mesh, random)
		});
	}
	for (let face = 0, count = 0; face < mesh.triangles.length && count < 16; face++)
		for (let edge = 0; edge < 3 && count < 16; edge++) {
			const neighbor = mesh.neighbors[face][edge];
			const periodicSeam = neighbor >= 0 && Math.abs(neighbor - face) > mesh.triangles.length / 2;
			if (mesh.edgeParity[face][edge] !== -1 && neighbor !== -1 && !periodicSeam) continue;
			const bary = [0.4995, 0.4995, 0.4995];
			bary[edge] = 0.001;
			const point = meshModel.topologyPoint(mesh, face, bary);
			const f = mesh.triangles[face],
				opposite = mesh.vertices[f[edge]],
				a = mesh.vertices[f[(edge + 1) % 3]],
				b = mesh.vertices[f[(edge + 2) % 3]];
			const outward = unit(sub(scale(add(a, b), 0.5), opposite));
			fixtures.push({
				sample: { triangle: face, barycentric: bary, position: point, orientation: 1 },
				v: scale(outward, 2.8),
				displacement: scale(outward, 0.06),
				other: {
					triangle: neighbor < 0 ? face : neighbor,
					position:
						neighbor < 0 ? point : meshModel.topologyPoint(mesh, neighbor, [1 / 3, 1 / 3, 1 / 3])
				}
			});
			count++;
		}
	const data = packedConfig(scene, 1),
		inputWords = new Float32Array(fixtures.length * 24);
	fixtures.forEach((f, i) => {
		const otherNormal = mesh.normals[f.other.triangle];
		const otherVelocity = sub(f.v, scale(otherNormal, dot(f.v, otherNormal)));
		inputWords.set(
			[
				...f.sample.position,
				f.sample.triangle + 1,
				...f.displacement,
				f.sample.orientation ?? 1,
				...f.v,
				0,
				...f.v,
				0,
				...f.other.position,
				f.other.triangle + 1,
				...otherVelocity,
				0
			],
			i * 24
		);
	});
	const config = gpu.device.createBuffer({ size: data.byteLength, usage: ['storage', 'copy_dst'] });
	const input = gpu.device.createBuffer({
		size: inputWords.byteLength,
		usage: ['storage', 'copy_dst']
	});
	const result = gpu.device.createBuffer({
		size: inputWords.byteLength,
		usage: ['storage', 'copy_src']
	});
	try {
		config.write(data);
		input.write(inputWords);
		compute(gpu, probeSource, { entry: 'probe', set: { config, input, result } }).dispatch(
			Math.ceil(fixtures.length / 128)
		);
		const actual = new Float32Array(await result.read(inputWords.byteLength));
		for (let i = 0; i < fixtures.length; i++) {
			const words = inputWords.subarray(i * 24, (i + 1) * 24),
				values = actual.subarray(i * 24, (i + 1) * 24);
			const face = words[3] - 1,
				p = [...words.subarray(0, 3)],
				q = [...words.subarray(16, 19)];
			const expected = meshModel.walkTopology(
				mesh,
				{
					triangle: face,
					barycentric: meshModel.topologyBarycentric(mesh, face, p),
					orientation: words[7]
				},
				[...words.subarray(4, 7)],
				[...words.subarray(8, 11)],
				128
			);
			assert.equal(values[11], 1, `${scene.world.shape} complete edge walk ${i}`);
			assert.equal(expected.complete, true, 'CPU complete edge walk');
			assert.equal(values[3], expected.triangle + 1, `${scene.world.shape} final face ${i}`);
			assert.equal(values[7], expected.orientation, `${scene.world.shape} orientation ${i}`);
			vectorClose([...values.subarray(0, 3)], expected.position, 'walk position', 6e-5);
			vectorClose([...values.subarray(4, 7)], expected.velocity, 'walk velocity', 6e-5);
			const relation = relationModel.topologyRelation(table, face, words[19] - 1, p, q, [
				...words.subarray(20, 23)
			]);
			assert.equal(values[19], Number(!!relation), 'sheet-aware relation availability');
			if (relation) {
				vectorClose(
					[...values.subarray(12, 15)],
					relation.displacement,
					'relation displacement',
					8e-5
				);
				close(values[15], relation.distance, 'relation distance', 8e-5);
				vectorClose([...values.subarray(16, 19)], relation.velocity, 'relation velocity', 8e-5);
			}
		}
	} finally {
		config.destroy();
		input.destroy();
		result.destroy();
	}
	console.log(
		`Topology ${scene.world.shape}: ${fixtures.length} Float32 motion/transport/relation fixtures passed`
	);
}
async function neighborhoodGate(scene, mesh, table, clustered) {
	const agents = model.initializePopulation(scene).agents;
	if (clustered) {
		const random = model.seededRandom(0x926faca1),
			face = Math.floor(mesh.triangles.length / 3);
		agents.forEach((agent, i) => {
			// Crowded memberships have no fixed capacity, including coincident pairs.
			const bary =
				i % 4 === 0 ? [0.3, 0.3, 0.4] : [0.25 + random() * 0.05, 0.25 + random() * 0.05, 0];
			bary[2] = 1 - bary[0] - bary[1];
			agent.triangle = face;
			agent.orientation = i % 3 ? 1 : -1;
			agent.position = meshModel.topologyPoint(mesh, face, bary);
			agent.velocity = scale(
				unit(sub(mesh.vertices[mesh.triangles[face][1]], mesh.vertices[mesh.triangles[face][0]])),
				1 + i / agents.length
			);
		});
	}
	await withBuffers(scene, agents, async (test) => {
		test.bootstrap();
		const canonical = canonicalAgents(scene, test.words),
			metrics = await test.measure();
		canonical.forEach((_, index) => {
			const expected = referenceMetrics(scene, mesh, table, canonical, index);
			expected.forEach((value, field) => {
				const actual = metrics[index * 16 + field];
				const label = `${scene.world.shape} ${clustered ? 'dense' : 'uniform'} agent${index} ${metricsFields[field]}`;
				if ([8, 10, 11, 12].includes(field)) close(circular(actual, value), 0, label, 0.0015);
				else close(actual, value, label, field === 3 ? 0 : field === 2 ? 0.004 : 0.0015);
			});
		});
	});
	console.log(
		`Topology ${scene.world.shape}: ${agents.length} ${clustered ? 'crowded/coincident' : 'uniform'} complete GPU neighborhoods and fifteen metrics match all-pairs reference`
	);
}
async function freeMotionGate(scene, mesh) {
	const agents = model.initializePopulation(scene).agents;
	scene.dynamics.collision = 0;
	agents.forEach((a) => {
		a.velocity = scale(unit(a.velocity), 2.1);
	});
	await withBuffers(scene, agents, async (test) => {
		test.bootstrap();
		for (let i = 0; i < 120; i++) test.step();
		const state = await test.state(),
			metrics = await test.measure();
		for (let i = 0; i < agents.length; i++) {
			const words = state.subarray(i * 16, (i + 1) * 16),
				face = words[3] - 1;
			assert.ok(
				Number.isInteger(face) && face >= 0 && face < mesh.triangles.length,
				'valid retained face'
			);
			assert.ok([...words.subarray(0, 12)].every(Number.isFinite), 'finite state');
			assert.equal(words[11], 0, `${scene.world.shape} walker guard flag`);
			assert.ok(words[7] === 1 || words[7] === -1, 'orientation double cover');
			const position = [...words.subarray(0, 3)],
				velocity = [...words.subarray(4, 7)];
			const bary = meshModel.topologyBarycentric(mesh, face, position);
			assert.ok(
				bary.every((value) => value >= -0.0001 && value <= 1.0001),
				'position stays in retained triangle'
			);
			close(dot(velocity, mesh.normals[face]), 0, 'tangent velocity', 0.00015);
			close(length(velocity), 2.1, 'speed preserved', 0.0002);
			const boundaryBounce = scene.world.shape === 'mobius';
			if (!boundaryBounce) {
				close(metrics[i * 16 + 1], 0, 'free geodesic covariant turning', 0.001);
				close(metrics[i * 16 + 2], 0, 'free geodesic covariant acceleration', 0.002);
			}
		}
	});
	console.log(
		`Topology ${scene.world.shape}: 120 physical ticks retain face/speed/tangency/orientation with no walk truncation`
	);
}
function pairFixture(scene, mesh) {
	const face = mesh.areas.indexOf(Math.max(...mesh.areas));
	const p = meshModel.topologyPoint(mesh, face, [0.4, 0.3, 0.3]);
	const q = meshModel.topologyPoint(mesh, face, [0.4, 0.4, 0.2]);
	const direction = unit(sub(q, p));
	const around = unit(cross(mesh.normals[face], direction));
	const agent = (id, position, velocity) => ({
		id,
		birth: id,
		speciesKey: scene.species[id - 1].key,
		position,
		velocity,
		triangle: face,
		orientation: 1
	});
	return {
		face,
		p,
		q,
		direction,
		around,
		agents: [agent(1, p, [0, 0, 0]), agent(2, q, scale(around, 1.1))]
	};
}
async function directedGate(shape, mesh) {
	for (const behavior of model.BEHAVIORS) {
		const scene = sceneFor(shape, 2);
		scene.species.forEach((species) => {
			species.force = 20;
			species.speed = 6;
			species.size = 0.001;
		});
		const fixture = pairFixture(scene, mesh);
		scene.speciesRules = [
			{
				id: `probe-${behavior}`,
				from: scene.species[0].key,
				to: scene.species[1].key,
				behavior,
				strength: 1,
				radius: null
			}
		];
		await withBuffers(scene, fixture.agents, async (test) => {
			test.bootstrap();
			test.step();
			const state = await test.state(),
				velocity = [...state.subarray(4, 7)];
			assert.equal(state[11], 0, `${shape}/${behavior} complete motion`);
			assert.ok(velocity.every(Number.isFinite), 'finite directed result');
			const radial = dot(velocity, fixture.direction),
				circulation = dot(velocity, fixture.around);
			if (behavior === 'ignore') close(length(velocity), 0, 'Ignore is explicit', 1e-6);
			else {
				assert.ok(length(velocity) > 1e-5, `${shape}/${behavior} responds`);
				if (['flee', 'guard', 'disperse'].includes(behavior))
					assert.ok(radial < -1e-5, `${behavior} escapes`);
				if (['chase', 'cohere', 'mob', 'spiral'].includes(behavior))
					assert.ok(radial > 1e-5, `${behavior} approaches`);
				if (['align', 'orbit'].includes(behavior))
					assert.ok(circulation > 1e-5, `${behavior} follows the configured tangent motion`);
				if (behavior === 'mirror') assert.ok(circulation < -1e-5, 'Mirror opposes target motion');
				if (behavior === 'follow')
					assert.ok(
						dot(
							velocity,
							sub(
								sub(fixture.q, fixture.p),
								scale(fixture.around, scene.species[0].perception * 0.35)
							)
						) > 1e-5,
						'Follow heads behind target'
					);
			}
		});
	}
	const scene = sceneFor(shape, 2);
	scene.species.forEach((species) => {
		species.force = 20;
		species.size = 0.001;
	});
	const fixture = pairFixture(scene, mesh);
	scene.speciesRules = [
		{
			id: 'fallback-flee',
			from: scene.species[0].key,
			to: '*',
			behavior: 'flee',
			strength: 1,
			radius: null
		},
		{
			id: 'explicit-ignore',
			from: scene.species[0].key,
			to: scene.species[1].key,
			behavior: 'ignore',
			strength: 0,
			radius: null
		}
	];
	await withBuffers(scene, fixture.agents, async (test) => {
		test.bootstrap();
		test.step();
		const state = await test.state();
		close(length([...state.subarray(4, 7)]), 0, 'Explicit Ignore overrides fallback Flee', 1e-6);
	});
	console.log(
		`Topology ${shape}: all twelve directed behaviors and explicit fallback precedence passed`
	);
}
async function forceObstacleGate(shape, mesh, table) {
	for (const response of ['attract', 'repel', 'vortex']) {
		const scene = sceneFor(shape, 1),
			fixture = pairFixture(scene, mesh);
		scene.forces.enabled = true;
		scene.species[0].force = 10;
		scene.species[0].cursor.response = response === 'vortex' ? 'ignore' : response;
		scene.species[0].cursor.vortex = response === 'vortex' ? 1 : 0;
		await withBuffers(scene, fixture.agents.slice(0, 1), async (test) => {
			test.bootstrap();
			test.step({
				field: { active: true, position: fixture.q, triangle: fixture.face, pressed: false }
			});
			const state = await test.state(),
				velocity = [...state.subarray(4, 7)];
			const projection = dot(velocity, response === 'vortex' ? fixture.around : fixture.direction);
			assert.ok(
				(response === 'repel' ? -projection : projection) > 1e-5,
				`Face-attached ${response} pointer field`
			);
			assert.equal(state[11], 0, 'force motion completes');
		});
	}
	const scene = sceneFor(shape, 1),
		fixture = pairFixture(scene, mesh);
	scene.obstacles = [
		{ id: 'face-disk', shape: 'sphere', center: fixture.p, radius: 0.1, triangle: fixture.face }
	];
	await withBuffers(scene, fixture.agents.slice(0, 1), async (test) => {
		test.bootstrap();
		test.step();
		const state = await test.state(),
			face = state[3] - 1,
			position = [...state.subarray(0, 3)];
		const relation = relationModel.topologyRelation(table, face, fixture.face, position, fixture.p);
		assert.ok(relation && relation.distance >= 0.1198, `Intrinsic obstacle contact ${shape}`);
		assert.equal(state[11], 0, 'contact edge walk completes');
		const bary = meshModel.topologyBarycentric(mesh, face, position);
		assert.ok(
			bary.every((value) => value >= -0.0001),
			'contact remains on retained sheet'
		);
	});
	console.log(
		`Topology ${shape}: face-attached attraction/repulsion/vortex and intrinsic obstacle contact passed`
	);
}
async function immersedSheetGate(shape, mesh) {
	if (!['klein', 'projective'].includes(shape)) return;
	const pairs = findSurfaceIntersections(mesh);
	assert.equal(pairs.length, 8, `${shape} has actual independent immersion preimages`);
	for (const fixture of pairs) {
		const { point, fromTriangle: faceA, toTriangle: faceB } = fixture;
		vectorClose(
			meshModel.topologyPoint(mesh, faceA, fixture.fromBarycentric),
			point,
			'first actual sheet intersection',
			1e-9
		);
		vectorClose(
			meshModel.topologyPoint(mesh, faceB, fixture.toBarycentric),
			point,
			'second actual sheet intersection',
			1e-9
		);
		assert.ok(
			Math.min(...fixture.fromBarycentric, ...fixture.toBarycentric) >= -1e-9,
			'intersection lies within both disconnected triangles'
		);
		const scene = sceneFor(shape, 2);
		const agents = [faceA, faceB].map((triangle, index) => ({
			id: index + 1,
			birth: index + 1,
			speciesKey: scene.species[index].key,
			position: point,
			velocity: [0, 0, 0],
			triangle,
			orientation: 1
		}));
		await withBuffers(scene, agents, async (test) => {
			test.bootstrap();
			const measured = await test.measure();
			assert.equal(measured[3], 0, `${shape} first sheet excludes the coincident agent`);
			assert.equal(measured[19], 0, `${shape} second sheet excludes the coincident agent`);
			test.step();
			const state = await test.state();
			for (let agent = 0; agent < 2; agent++) {
				assert.equal(
					state[agent * 16 + 3],
					agents[agent].triangle + 1,
					'contact retains original sheet identity'
				);
				vectorClose(
					[...state.subarray(agent * 16, agent * 16 + 3)],
					point,
					'independent sheet has no false collision movement',
					2e-6
				);
			}
		});
	}
	console.log(
		`Topology ${shape}: ${pairs.length} identical-XYZ independent-sheet triangle crossings correctly excluded`
	);
}
try {
	for (const shape of shapes) {
		const scene = sceneFor(shape),
			mesh = model.topologyMesh(scene.world);
		const table = relationModel.createTopologyRelations(
			mesh,
			model.worldInteractionLimit(scene.world)
		);
		await geometryGate(scene, mesh, table);
		await neighborhoodGate(scene, mesh, table, false);
		const dense = sceneFor(shape, 320);
		await neighborhoodGate(dense, mesh, table, true);
		await freeMotionGate(scene, mesh);
		await directedGate(shape, mesh);
		await forceObstacleGate(shape, mesh, table);
		await immersedSheetGate(shape, mesh);
	}
	assert.deepEqual(errors, [], 'native validation errors');
	console.log('All native topology gates passed');
} finally {
	runtime?.dispose?.();
	gpu.dispose();
	if (!originalShaderStage) delete globalThis.GPUShaderStage;
}
