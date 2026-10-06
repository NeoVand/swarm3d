import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { init, compute } from 'vgpu/node';

// Actual production WGSL and complete prefix/scatter neighborhoods. Möbius,
// Klein and Trefoil use a continuous induced metric; Projective deliberately
// retains its declared local polyhedral classifier.
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
	smoothModel,
	createComputeRuntime,
	findSurfaceIntersections;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
	topologyPacking = await vite.ssrLoadModule('/src/lib/gpu/topology.ts');
	meshModel = await vite.ssrLoadModule('/src/lib/model/topology-mesh.ts');
	relationModel = await vite.ssrLoadModule('/src/lib/model/topology-relations.ts');
	smoothModel = await vite.ssrLoadModule('/src/lib/model/topology-smooth.ts');
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
import { smooth_kind, smooth_topology, smooth_advance, smooth_relation, smooth_face_tag } from "../src/lib/gpu/shaders/topology-smooth.wgsl";
@group(0) @binding(0) var<storage,read> config:array<vec4f>;
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(128) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&input)/6u){return;}
 let i=id.x*6u;
 if(smooth_kind(config[0].z)) {
  let originUV=vec2f(input[i].w,input[i+2u].w);
  let motion=smooth_advance(&config,originUV,input[i+1u].w,input[i+1u].xyz,input[i+2u].xyz,input[i+3u].xyz);
  let relation=smooth_relation(&config,originUV,smooth_topology(&config,originUV),vec2f(input[i+4u].w,input[i+5u].w),input[i+5u].xyz);
  result[i]=vec4f(motion.position,motion.uv.x);result[i+1u]=vec4f(motion.velocity,motion.orientation);
  result[i+2u]=vec4f(motion.previousVelocity,motion.uv.y);
  result[i+3u]=vec4f(relation.displacement,relation.distance);
  result[i+4u]=vec4f(relation.velocity,1.0);
  result[i+5u]=vec4f(smooth_topology(&config,motion.uv).normal,smooth_face_tag(&config,motion.uv));
  return;
 }
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
function sceneFor(shape, population = 80, tubeRatio) {
	const scene = model.createDefaultScene();
	scene.world = {
		kind: 'surface',
		shape,
		radius: 14,
		...(shape === 'trefoil' && tubeRatio !== undefined ? { tubeRadius: 14 * tubeRatio } : {})
	};
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
			if (smoothModel.isSmoothTopologyWorld(scene.world)) {
				const chart =
					agent.chart ??
					smoothModel.smoothTopologyChart(scene.world, agent.position, agent.triangle);
				close(words[i * 16 + 3], chart[0], `${scene.world.shape} packed chart U`, 1e-7);
				close(words[i * 16 + 11], chart[1], `${scene.world.shape} packed chart V`, 1e-7);
			} else
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
		const relation = smoothModel.isSmoothTopologyWorld(scene.world)
			? smoothModel.smoothTopologyRelation(scene.world, self.chart, other.chart, other.velocity)
			: relationModel.topologyRelation(
					table,
					self.triangle,
					other.triangle,
					self.position,
					other.position,
					other.velocity
				);
		if (relation && relation.distance <= radius) relations.push(relation);
	});
	const smooth = smoothModel.isSmoothTopologyWorld(scene.world)
		? smoothModel.smoothTopologySurface(scene.world, self.chart)
		: null;
	const normal = scale(smooth?.normal ?? mesh.normals[self.triangle], self.orientation ?? 1);
	const face = mesh.triangles[self.triangle],
		east = unit(smooth?.u ?? sub(mesh.vertices[face[1]], mesh.vertices[face[0]])),
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
async function runGeometryProbe(data, inputWords) {
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
			Math.ceil(inputWords.length / 24 / 128)
		);
		return new Float32Array(await result.read(inputWords.byteLength));
	} finally {
		config.destroy();
		input.destroy();
		result.destroy();
	}
}
async function smoothGeometryGate(scene) {
	const world = scene.world,
		random = model.seededRandom(0x591f238a),
		fixtures = [],
		continuityPairs = [];
	function fixture(uv, other = [uv[0] + 0.002, uv[1] + 0.003], movement = 1 / 60) {
		const a = smoothModel.smoothTopologySurface(world, uv),
			b = smoothModel.smoothTopologySurface(world, other),
			angle = random() * 2 * Math.PI;
		const east = unit(a.u),
			north = unit(cross(a.normal, east)),
			velocity = scale(add(scale(east, Math.cos(angle)), scale(north, Math.sin(angle))), 2.8);
		fixtures.push({
			uv,
			other,
			velocity,
			displacement: scale(velocity, movement),
			otherVelocity: scale(unit(b.u), 1.7)
		});
		return fixtures.length - 1;
	}
	for (let index = 0; index < 80; index++) fixture([0.02 + random() * 0.96, 0.05 + random() * 0.9]);
	// Deliberately cross the reflected/periodic U seam, transverse seam, and open
	// Möbius edge. These expected charts come from continuous midpoint motion.
	for (const uv of [
		[0.99995, 0.32],
		[0.00005, 0.68],
		[0.32, 0.99995],
		[0.32, 0.00005]
	]) {
		const index = fixture(uv),
			surface = smoothModel.smoothTopologySurface(world, uv),
			direction =
				uv[0] > 0.9
					? unit(surface.u)
					: uv[0] < 0.1
						? scale(unit(surface.u), -1)
						: uv[1] > 0.9
							? unit(surface.v)
							: scale(unit(surface.v), -1);
		fixtures[index].velocity = scale(direction, 2.8);
		fixtures[index].displacement = scale(direction, 0.06);
	}
	const [nu, nv] = smoothModel.smoothTopologyDimensions(world.shape);
	for (const [uv, axis] of [
		[[Math.floor(nu * 0.31) / nu, 0.37], 0],
		[[0.31, Math.floor(nv * 0.41) / nv], 1],
		[[(Math.floor(nu * 0.31) + 0.5) / nu, (Math.floor(nv * 0.41) + 0.5) / nv], 0]
	]) {
		const target = [uv[0] + 0.002, uv[1] + 0.003],
			left = [...uv],
			right = [...uv];
		left[axis] -= 1e-7;
		right[axis] += 1e-7;
		const first = fixture(left, target, 0),
			second = fixture(right, target, 0);
		fixtures[second].velocity = fixtures[first].velocity;
		fixtures[second].otherVelocity = fixtures[first].otherVelocity;
		continuityPairs.push([first, second]);
	}
	let known;
	if (world.shape === 'mobius') {
		known = fixture([0.213, 0.5], [0.223, 0.5], 0);
		fixtures[known].knownDistance = 2 * Math.PI * (world.radius / 1.28) * 0.01;
	} else {
		const u = world.shape === 'klein' ? 0.75 : 0.173;
		known = fixture([u, 0.236], [u, 0.256], 0);
		const ringRadius =
			world.shape === 'trefoil'
				? model.trefoilTubeRadius(world)
				: length(
						sub(
							smoothModel.smoothTopologySurface(world, [u, 0]).position,
							smoothModel.smoothTopologySurface(world, [u, 0.5]).position
						)
					) / 2;
		fixtures[known].knownDistance = 2 * Math.PI * ringRadius * 0.02;
	}
	const input = new Float32Array(fixtures.length * 24);
	fixtures.forEach((value, index) => {
		const surface = smoothModel.smoothTopologySurface(world, value.uv),
			other = smoothModel.canonicalSmoothChart(world.shape, value.other).uv;
		input.set(
			[
				...surface.position,
				value.uv[0],
				...value.displacement,
				1,
				...value.velocity,
				value.uv[1],
				...value.velocity,
				0,
				...smoothModel.smoothTopologySurface(world, other).position,
				other[0],
				...value.otherVelocity,
				other[1]
			],
			index * 24
		);
	});
	const data = packedConfig(scene, 1),
		actual = await runGeometryProbe(data, input);
	for (let index = 0; index < fixtures.length; index++) {
		const words = input.subarray(index * 24, (index + 1) * 24),
			values = actual.subarray(index * 24, (index + 1) * 24),
			uv = [words[3], words[11]],
			other = [words[19], words[23]],
			moving = [...words.subarray(8, 11)];
		const expected = smoothModel.smoothTopologyAdvance(
				world,
				uv,
				[...words.subarray(4, 7)],
				moving,
				moving,
				words[7]
			),
			relation = smoothModel.smoothTopologyRelation(world, uv, other, [...words.subarray(20, 23)]),
			normal = smoothModel.smoothTopologySurface(world, expected.chart).normal;
		assert.ok(
			[...values].every(Number.isFinite),
			`${world.shape} finite continuous probe ${index}`
		);
		vectorClose([...values.subarray(0, 3)], expected.position, 'smooth world position', 0.00015);
		vectorClose([...values.subarray(4, 7)], expected.velocity, 'smooth transported motion', 0.0002);
		vectorClose(
			[...values.subarray(8, 11)],
			expected.transportedPriorVelocity,
			'smooth prior transport',
			0.0002
		);
		close(circular(values[3], expected.chart[0]), 0, 'smooth normalized U', 1e-6);
		close(
			world.shape === 'mobius'
				? Math.abs(values[11] - expected.chart[1])
				: circular(values[11], expected.chart[1]),
			0,
			'smooth normalized V',
			1e-6
		);
		assert.equal(values[7], expected.orientation, 'reflected-seam parity transport');
		vectorClose(
			[...values.subarray(12, 15)],
			relation.displacement,
			'smooth metric displacement',
			0.0003
		);
		close(values[15], relation.distance, 'smooth induced-metric distance', 0.0003);
		vectorClose(
			[...values.subarray(16, 19)],
			relation.velocity,
			'smooth neighbor transport',
			0.0003
		);
		vectorClose([...values.subarray(20, 23)], normal, 'smooth derivative normal', 0.0003);
		close(dot([...values.subarray(4, 7)], normal), 0, 'smooth tangent velocity', 0.0003);
		close(length([...values.subarray(4, 7)]), length(moving), 'smooth physical speed', 0.0003);
		if (fixtures[index].knownDistance !== undefined)
			close(
				values[15],
				fixtures[index].knownDistance,
				`${world.shape} independent circular arc distance`,
				0.0003
			);
	}
	for (const [a, b] of continuityPairs) {
		vectorClose(
			[...actual.subarray(a * 24, a * 24 + 3)],
			[...actual.subarray(b * 24, b * 24 + 3)],
			'C1 position across chart/triangle border',
			0.0001
		);
		vectorClose(
			[...actual.subarray(a * 24 + 12, a * 24 + 15)],
			[...actual.subarray(b * 24 + 12, b * 24 + 15)],
			'continuous neighborhood displacement across chart/triangle border',
			0.0002
		);
		close(
			actual[a * 24 + 15],
			actual[b * 24 + 15],
			'continuous neighborhood distance across chart/triangle border',
			0.0002
		);
		vectorClose(
			[...actual.subarray(a * 24 + 20, a * 24 + 23)],
			[...actual.subarray(b * 24 + 20, b * 24 + 23)],
			'C1 normal across chart/triangle border',
			0.0003
		);
	}
	// Rigidly rotate only the immutable smooth field and all fixture vectors.
	// The oracle compares directly to the original GPU output, independently of
	// the CPU relation implementation or a hand-picked world orientation.
	const rotate = ([x, y, z]) => {
		const tilted = [
			x,
			y * Math.cos(0.37) - z * Math.sin(0.37),
			y * Math.sin(0.37) + z * Math.cos(0.37)
		];
		return [
			tilted[0] * Math.cos(0.61) - tilted[1] * Math.sin(0.61),
			tilted[0] * Math.sin(0.61) + tilted[1] * Math.cos(0.61),
			tilted[2]
		];
	};
	const rotatedConfig = data.slice(),
		rotatedInput = input.slice(),
		field = data[(16 + 2 * scene.obstacles.length) * 4 + 3];
	for (let row = field + 1; row < data.length / 4; row++)
		rotatedConfig.set(rotate(data.subarray(row * 4, row * 4 + 3)), row * 4);
	for (let row = 0; row < input.length / 4; row++)
		rotatedInput.set(rotate(input.subarray(row * 4, row * 4 + 3)), row * 4);
	const rotated = await runGeometryProbe(rotatedConfig, rotatedInput);
	for (let row = 0; row < actual.length / 4; row++) {
		vectorClose(
			[...rotated.subarray(row * 4, row * 4 + 3)],
			rotate(actual.subarray(row * 4, row * 4 + 3)),
			`${world.shape} rigid rotation covariance`,
			0.0005
		);
		close(
			rotated[row * 4 + 3],
			actual[row * 4 + 3],
			'rotation-invariant chart/distance/parity',
			row % 6 === 5 ? 1 : 0.00003
		);
	}
	console.log(
		`Topology ${world.shape}: ${fixtures.length} smooth motion/transport/seam probes, independent circular arc, three C1 cell/triangle crossings, and rigid rotation covariance passed`
	);
}
async function geometryGate(scene, mesh, table) {
	if (smoothModel.isSmoothTopologyWorld(scene.world)) return smoothGeometryGate(scene);
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
			if (smoothModel.isSmoothTopologyWorld(scene.world)) {
				agent.chart = [0, 1].map((axis) =>
					mesh.charts[face].reduce((sum, p, index) => sum + p[axis] * bary[index], 0)
				);
				agent.position = smoothModel.smoothTopologySurface(scene.world, agent.chart).position;
			}
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
		const checked =
			clustered && smoothModel.isSmoothTopologyWorld(scene.world)
				? Array.from({ length: 16 }, (_, index) =>
						Math.floor((index * (canonical.length - 1)) / 15)
					)
				: canonical.map((_, index) => index);
		if (clustered)
			canonical.forEach((_, index) =>
				assert.equal(
					metrics[index * 16 + 3],
					agents.length - 1,
					'every crowded membership is visited without truncation'
				)
			);
		checked.forEach((index) => {
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
		`Topology ${scene.world.shape}: ${agents.length} ${clustered ? 'crowded/coincident' : 'uniform'} complete GPU neighborhoods; fifteen metrics match all-pairs reference${clustered && smoothModel.isSmoothTopologyWorld(scene.world) ? ' for sixteen observers' : ''}`
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
				chart = smoothModel.isSmoothTopologyWorld(scene.world) ? [words[3], words[11]] : null,
				face = chart ? smoothModel.smoothTopologyTriangle(scene.world, chart) : words[3] - 1;
			assert.ok(
				Number.isInteger(face) && face >= 0 && face < mesh.triangles.length,
				'valid retained face'
			);
			assert.ok([...words.subarray(0, 12)].every(Number.isFinite), 'finite state');
			if (!chart) assert.equal(words[11], 0, `${scene.world.shape} walker guard flag`);
			assert.ok(words[7] === 1 || words[7] === -1, 'orientation double cover');
			const position = [...words.subarray(0, 3)],
				velocity = [...words.subarray(4, 7)];
			if (chart) {
				assert.ok(
					chart.every((value) => value >= 0 && value <= 1),
					'canonical continuous chart'
				);
				const surface = smoothModel.smoothTopologySurface(scene.world, chart);
				vectorClose(
					position,
					surface.position,
					'position stays on continuous visible map',
					0.00015
				);
				close(dot(velocity, surface.normal), 0, 'smooth tangent velocity', 0.0003);
			} else {
				const bary = meshModel.topologyBarycentric(mesh, face, position);
				assert.ok(
					bary.every((value) => value >= -0.0001 && value <= 1.0001),
					'position stays in retained triangle'
				);
				close(dot(velocity, mesh.normals[face]), 0, 'tangent velocity', 0.00015);
			}
			close(length(velocity), 2.1, 'speed preserved', 0.0002);
			const boundaryBounce = scene.world.shape === 'mobius';
			if (!boundaryBounce) {
				close(metrics[i * 16 + 1], 0, 'free geodesic covariant turning', 0.001);
				close(metrics[i * 16 + 2], 0, 'free geodesic covariant acceleration', 0.002);
			}
		}
	});
	console.log(
		`Topology ${scene.world.shape}: 120 physical ticks retain ${smoothModel.isSmoothTopologyWorld(scene.world) ? 'continuous chart' : 'face'}/speed/tangency/orientation${smoothModel.isSmoothTopologyWorld(scene.world) ? '' : ' with no walk truncation'}`
	);
}
function pairFixture(scene, mesh) {
	const face = mesh.areas.indexOf(Math.max(...mesh.areas));
	const bary = [
			[0.4, 0.3, 0.3],
			[0.4, 0.4, 0.2]
		],
		charts = smoothModel.isSmoothTopologyWorld(scene.world)
			? bary.map((weights) =>
					[0, 1].map((axis) =>
						mesh.charts[face].reduce((sum, point, index) => sum + point[axis] * weights[index], 0)
					)
				)
			: null;
	const p = charts
		? smoothModel.smoothTopologySurface(scene.world, charts[0]).position
		: meshModel.topologyPoint(mesh, face, bary[0]);
	const q = charts
		? smoothModel.smoothTopologySurface(scene.world, charts[1]).position
		: meshModel.topologyPoint(mesh, face, bary[1]);
	const direction = unit(
		charts
			? smoothModel.smoothTopologyRelation(scene.world, charts[0], charts[1]).displacement
			: sub(q, p)
	);
	const normal = charts
		? smoothModel.smoothTopologySurface(scene.world, charts[0]).normal
		: mesh.normals[face];
	const around = unit(cross(normal, direction));
	const agent = (id, position, velocity) => ({
		id,
		birth: id,
		speciesKey: scene.species[id - 1].key,
		position,
		velocity,
		triangle: face,
		...(charts ? { chart: charts[id - 1] } : {}),
		orientation: 1
	});
	return {
		face,
		p,
		q,
		direction,
		around,
		charts,
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
			if (!smoothModel.isSmoothTopologyWorld(scene.world))
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
			if (!smoothModel.isSmoothTopologyWorld(scene.world))
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
			chart = smoothModel.isSmoothTopologyWorld(scene.world) ? [state[3], state[11]] : null,
			face = chart ? smoothModel.smoothTopologyTriangle(scene.world, chart) : state[3] - 1,
			position = [...state.subarray(0, 3)];
		const relation = chart
			? smoothModel.smoothTopologyRelation(scene.world, chart, fixture.charts[0])
			: relationModel.topologyRelation(table, face, fixture.face, position, fixture.p);
		assert.ok(relation && relation.distance >= 0.1198, `Intrinsic obstacle contact ${shape}`);
		if (chart) {
			assert.ok(
				chart.every((value) => value >= 0 && value <= 1),
				'contact retains valid smooth chart'
			);
			vectorClose(
				position,
				smoothModel.smoothTopologySurface(scene.world, chart).position,
				'smooth contact remains on retained sheet',
				0.00015
			);
		} else {
			assert.equal(state[11], 0, 'contact edge walk completes');
			const bary = meshModel.topologyBarycentric(mesh, face, position);
			assert.ok(
				bary.every((value) => value >= -0.0001),
				'contact remains on retained sheet'
			);
		}
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
			const canonical = canonicalAgents(scene, test.words);
			assert.ok(
				length(sub(canonical[0].position, canonical[1].position)) <
					Math.min(...scene.species.map((s) => s.perception)),
				'crossing preimages are extrinsically closer than the query radius'
			);
			const measured = await test.measure();
			assert.equal(measured[3], 0, `${shape} first sheet excludes the coincident agent`);
			assert.equal(measured[19], 0, `${shape} second sheet excludes the coincident agent`);
			test.step();
			const state = await test.state();
			for (let agent = 0; agent < 2; agent++) {
				if (smoothModel.isSmoothTopologyWorld(scene.world)) {
					close(
						state[agent * 16 + 3],
						test.words[agent * 16 + 3],
						'contact retains original sheet U',
						1e-7
					);
					close(
						state[agent * 16 + 11],
						test.words[agent * 16 + 11],
						'contact retains original sheet V',
						1e-7
					);
				} else
					assert.equal(
						state[agent * 16 + 3],
						agents[agent].triangle + 1,
						'contact retains original sheet identity'
					);
				vectorClose(
					[...state.subarray(agent * 16, agent * 16 + 3)],
					canonical[agent].position,
					'independent sheet has no false collision movement',
					0.00002
				);
			}
		});
	}
	console.log(
		`Topology ${shape}: ${pairs.length} near-coincident independent immersion preimages correctly excluded`
	);
}
try {
	for (const shape of shapes) {
		const scene = sceneFor(shape),
			mesh = model.topologyMesh(scene.world);
		const table = smoothModel.isSmoothTopologyWorld(scene.world)
			? null
			: relationModel.createTopologyRelations(mesh, model.worldInteractionLimit(scene.world));
		await geometryGate(scene, mesh, table);
		await neighborhoodGate(scene, mesh, table, false);
		const dense = sceneFor(shape, 320);
		await neighborhoodGate(dense, mesh, table, true);
		await freeMotionGate(scene, mesh);
		await directedGate(shape, mesh);
		await forceObstacleGate(shape, mesh, table);
		await immersedSheetGate(shape, mesh);
	}
	// Each thickness changes the continuous derivative field. Reusing the same
	// production kernels with replacement buffers exercises actual rebinds.
	for (const ratio of [0.06, 0.16]) {
		const scene = sceneFor('trefoil', 80, ratio),
			mesh = model.topologyMesh(scene.world),
			table = null;
		console.log(`Trefoil tube ratio ${ratio}: replacement geometry and atlas binding`);
		await geometryGate(scene, mesh, table);
		await neighborhoodGate(scene, mesh, table, false);
		await neighborhoodGate(sceneFor('trefoil', 320, ratio), mesh, table, true);
		await freeMotionGate(scene, mesh);
	}
	assert.deepEqual(errors, [], 'native validation errors');
	console.log('All native topology gates passed');
} finally {
	runtime?.dispose?.();
	gpu.dispose();
	if (!originalShaderStage) delete globalThis.GPUShaderStage;
}
