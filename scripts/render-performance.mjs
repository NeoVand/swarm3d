import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, draw, frame, target, timer } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

// Frozen-input rendering experiment. These shader candidates remain outside the
// runtime until their images and GPU timestamps justify adopting them.
const require = createRequire(import.meta.url);
const dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const sourceRoot = resolve('src/lib/gpu/shaders');
const candidateRoot = resolve('.cache/render-sources');
await mkdir(candidateRoot, { recursive: true });
const originalVisual = await readFile(resolve(sourceRoot, 'visual.wgsl'), 'utf8');
const originalTrail = await readFile(resolve(sourceRoot, 'trails.wgsl'), 'utf8');
const originalBody = await readFile(resolve(sourceRoot, 'boids.wgsl'), 'utf8');
const imported = (source) =>
	source.replaceAll(
		'"./common.wgsl"',
		JSON.stringify(relative(candidateRoot, resolve(sourceRoot, 'common.wgsl')))
	);
const guardedVisual = originalVisual.replace(
	'if (definition.x>=0.0) { mapped=',
	'if (definition.x>=0.0 && (*params)[mapRow+9u].x>0.5 && definition.w>0.0) { mapped='
);
assert.notEqual(guardedVisual, originalVisual, 'current source must contain the unguarded mapping');
await writeFile(resolve(candidateRoot, 'visual-guarded.wgsl'), imported(guardedVisual));
const colorStart =
	'  let currentColor=agent_color(row,metrics[instance],&species,u32(config[13].x));';
const colorEnd = '  let rgb=mix(aColor,bColor,corner.x);';
const start = originalTrail.indexOf(colorStart),
	end = originalTrail.indexOf(colorEnd) + colorEnd.length;
assert.ok(start >= 0 && end > start, 'historical color block exists');
const fastColorBlock = `  let aRecord=history[u32(config[15].z)+aSlot];
  let bRecord=history[u32(config[15].z)+bSlot];
  let aValid=aRecord.w>=0.5 && finite_record(aRecord);
  let bValid=bRecord.w>=0.5 && finite_record(bRecord);
  var currentColor=vec3f(0.0);
  if (age==0u || !aValid || !bValid) {
    currentColor=agent_color(row,metrics[instance],&species,u32(config[13].x));
  }
  var aColor=currentColor;
  if (age>0u && aValid) { aColor=max(aRecord.xyz,vec3f(0.0)); }
  var bColor=currentColor;
  if (bValid) { bColor=max(bRecord.xyz,vec3f(0.0)); }
  let rgb=mix(aColor,bColor,corner.x);`;
const fastTrail = originalTrail.slice(0, start) + fastColorBlock + originalTrail.slice(end);
const withGuardedVisual = (source) =>
	imported(source).replaceAll('"./visual.wgsl"', '"./visual-guarded.wgsl"');
await writeFile(resolve(candidateRoot, 'trails-fast.wgsl'), withGuardedVisual(fastTrail));
await writeFile(resolve(candidateRoot, 'boids-fast.wgsl'), withGuardedVisual(originalBody));
const stripTrail = fastTrail
	.replace(
		'let particle=particles[instance];',
		'let segments=max(1u,u32(config[15].w));\n  let agent=instance/segments;\n  let particle=particles[agent];'
	)
	.replace(
		'if (instance>=u32(config[0].x) || samples<2u)',
		'if (instance>=u32(config[0].x)*max(1u,u32(config[15].w)) || samples<2u)'
	)
	.replace('let age=vertexIndex/6u;', 'let age=instance%segments;')
	.replaceAll('instance*samples', 'agent*samples')
	.replaceAll('metrics[instance]', 'metrics[agent]')
	.replace(
		'let corners=array<vec2f,6>(vec2f(0.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,1.0));',
		'let corners=array<vec2f,4>(vec2f(0.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0));'
	)
	.replace('let corner=corners[vertexIndex%6u];', 'let corner=corners[vertexIndex];');
await writeFile(resolve(candidateRoot, 'trails-strip.wgsl'), withGuardedVisual(stripTrail));
const indexedTrail = originalTrail
	.replace('let age=vertexIndex/6u;', 'let age=vertexIndex/4u;')
	.replace(
		'let corners=array<vec2f,6>(vec2f(0.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,1.0));',
		'let corners=array<vec2f,4>(vec2f(0.0,-1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0));'
	)
	.replace('let corner=corners[vertexIndex%6u];', 'let corner=corners[vertexIndex%4u];');
await writeFile(
	resolve(candidateRoot, 'trails-indexed.wgsl'),
	imported(indexedTrail).replaceAll(
		'"./visual.wgsl"',
		JSON.stringify(relative(candidateRoot, resolve(sourceRoot, 'visual.wgsl')))
	)
);
const shaders = Object.fromEntries(
	await Promise.all(
		[
			['body', resolve(sourceRoot, 'boids.wgsl')],
			['world', resolve(sourceRoot, 'world.wgsl')],
			['trail', resolve(sourceRoot, 'trails.wgsl')],
			['bodyFast', resolve(candidateRoot, 'boids-fast.wgsl')],
			['trailFast', resolve(candidateRoot, 'trails-fast.wgsl')],
			['trailStrip', resolve(candidateRoot, 'trails-strip.wgsl')],
			['trailIndexed', resolve(candidateRoot, 'trails-indexed.wgsl')]
		].map(async ([name, entry]) => [name, (await resolveShader({ entry })).wgsl])
	)
);
if (process.argv.includes('--prepare-only')) {
	console.log(
		JSON.stringify(
			{ prepared: candidateRoot, variants: Object.keys(shaders), gpuInitialized: false },
			null,
			2
		)
	);
	process.exit(0);
}
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
} finally {
	await vite.close();
}
const gpu = await init({
	requiredFeatures: ['timestamp-query'],
	requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxStorageBuffersInVertexStage: 5 }
});
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const renderTimer = timer(gpu);
const stage = target(gpu, { size: [1600, 1000], format: 'rgba16float', depth: true });
const camera = perspectiveCamera({
	fov: 42,
	aspect: 1.6,
	position: [34, 25, 42],
	target: [0, 0, 0],
	near: 0.05,
	far: 200
});
const cameraBlock = {
	viewProjection: camera.viewProjection,
	position: [...camera.worldPosition, 1],
	right: [1, 0, 0, 0],
	up: [0, 1, 0, 0]
};
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
const config = allocate('frozen render config', 16384);
const particles = allocate('frozen render particles', 20000 * packing.PARTICLE_BYTES);
const measured = allocate('frozen measured values', 20000 * packing.METRIC_BYTES);
const species = allocate('frozen appearance species', 16 * packing.SPECIES_ROWS * 16);
const history = allocate(
	'frozen world-space histories',
	20000 * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES
);
const trailIndices = gpu.device.createBuffer({
	label: 'shared trail quad index pattern',
	size: 63 * 6 * 2,
	usage: ['index', 'copy_dst']
});
owned.push(trailIndices);
trailIndices.write(
	Uint16Array.from({ length: 63 * 6 }, (_, i) => Math.floor(i / 6) * 4 + [0, 1, 2, 2, 1, 3][i % 6])
);
const bindings = { config, particles, metrics: measured, species, camera: cameraBlock };
const body = draw(gpu, {
	shader: shaders.body,
	vertices: 36,
	depth: { write: true },
	set: bindings
});
const bodyFast = draw(gpu, {
	shader: shaders.bodyFast,
	vertices: 36,
	depth: { write: true },
	set: bindings
});
const shell = draw(gpu, {
	shader: shaders.world,
	vertices: 10800,
	entry: { vertex: 'vs_shell', fragment: 'fs_shell' },
	writeMask: [],
	depth: { write: true },
	set: { config, camera: cameraBlock }
});
const trailDraw = (shader, strip = false) =>
	draw(gpu, {
		shader,
		vertices: strip ? 4 : 378,
		...(strip ? { geometry: { topology: 'triangle-strip', vertexCount: 4 } } : {}),
		depth: { write: false },
		blend: 'premultiplied',
		set: { ...bindings, history }
	});
const variants = {
	baseline: { body, trail: trailDraw(shaders.trail) },
	guarded: { body: bodyFast, trail: trailDraw(shaders.trailFast) },
	strip: { body: bodyFast, trail: trailDraw(shaders.trailStrip, true) },
	indexed: {
		body,
		trail: draw(gpu, {
			shader: shaders.trailIndexed,
			geometry: { indexBuffer: trailIndices.gpu, indexFormat: 'uint16', indexCount: 63 * 6 },
			depth: { write: false },
			blend: 'premultiplied',
			set: { ...bindings, history }
		})
	},
	production: {
		body,
		trail: draw(gpu, {
			shader: shaders.trail,
			entry: { vertex: 'vs_indexed', fragment: 'fs_main' },
			geometry: {
				indexBuffer: trailIndices.gpu,
				indexFormat: 'uint16',
				indexCount: 63 * 6
			},
			depth: { write: false },
			blend: 'premultiplied',
			set: { ...bindings, history }
		})
	}
};
const results = {
	recordedAt: new Date().toISOString(),
	adapter: gpu.gpu.adapterInfo,
	method:
		'Frozen matching particle/metric/history buffers; isolated native rendering; alternated variants, GPU pass timestamps, no simulation/RAF/concurrent swarm. Times are not interactive browser FPS.',
	cases: []
};
const quick = process.argv.includes('--quick');
const representative = process.argv.includes('--representative');
const populations = representative ? [10400] : quick ? [5000] : [5000, 10000, 20000];
const distributions = quick ? [false] : [false, true];
const budgets = representative ? [0, 43] : quick ? [32] : [0, 8, 32, 63];
const worlds = representative ? ['box'] : ['box', 'sphere'];
const resultFile = representative
	? '.cache/render-performance-user.json'
	: '.cache/render-performance.json';
let activeWorld = 'box';
let activeRanges = [];
let activeSampleDt = 0;
function setCase(population, world, cluster, segments) {
	activeWorld = world;
	const scene = model.resizePopulation(model.createDefaultScene(), population);
	if (world === 'sphere') scene.world = { kind: 'surface', shape: 'sphere', radius: 16 };
	for (const item of scene.species) item.trail.length = representative ? 1.4 : 3.2;
	if (representative) {
		scene.species[0].population = 5700;
		scene.species[1].population = 4700;
		scene.species[0].speed = 3.7;
		scene.species[0].cruiseSpeed = 0.8;
		scene.species[1].speed = 3.1;
		scene.species[1].cruiseSpeed = 3.1;
		scene.species[1].perception = 4;
		scene.species[1].visual.hue.source = 'anisotropy';
		scene.species[1].trail.length = 0.7;
	}
	const sampleDt = representative ? 1 / 30 : 0.05;
	activeSampleDt = sampleDt;
	let firstInstance = 0;
	activeRanges = [...scene.species]
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((species) => {
			const range = { firstInstance, instances: species.population, seconds: species.trail.length };
			firstInstance += species.population;
			return range;
		});
	const agents = model.initializePopulation(scene).agents;
	const metricData = new Float32Array((population * packing.METRIC_BYTES) / 4);
	const historyData = new Float32Array(
		(population * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES) / 4
	);
	const colorBase = population * packing.HISTORY_SAMPLES * 4;
	agents.forEach((agent, index) => {
		if (cluster) {
			if (world === 'box') agent.position = agent.position.map((v) => v * 0.04);
			else
				agent.position = model.projectWorldPoint(scene.world, [
					agent.position[0] * 0.01,
					agent.position[1] * 0.01,
					16
				]);
			agent.velocity = model.worldTangent(scene.world, agent.velocity, agent.position);
		}
		const speed = Math.hypot(...agent.velocity);
		metricData.set(
			[
				speed,
				(index % 97) / 31,
				0.2,
				12,
				0.004,
				0.5,
				0.75,
				0,
				(index % 163) / 163,
				0.8,
				0.25,
				0.5,
				0.125,
				0.3,
				0.2,
				0
			],
			index * 16
		);
		for (let age = 0; age < packing.HISTORY_SAMPLES; age++) {
			const slot =
				index * packing.HISTORY_SAMPLES +
				((packing.HISTORY_SAMPLES - age) % packing.HISTORY_SAMPLES);
			const displacement = agent.velocity.map((v) => -v * (0.018 + age * sampleDt));
			const point = model.worldExp(scene.world, agent.position, displacement);
			historyData.set([...point, 1], slot * 4);
			const color = scene.species[agent.speciesKey === scene.species[0].key ? 0 : 1].visual.hsl;
			const phase = age / 64;
			historyData.set(
				[
					0.12 + color[0] * 0.28 + phase * 0.4,
					0.08 + color[1] * 0.3,
					0.1 + color[2] * 0.4 - phase * 0.05,
					1
				],
				colorBase + slot * 4
			);
		}
	});
	const packedConfig = packing.packConfig(scene, {
		population,
		historyCapacity: population,
		tick: 120,
		historyHead: 0,
		validHistory: 64,
		smoothingAlpha: 1,
		historyElapsed: 0.018
	});
	packedConfig[15 * 4 + 3] = segments;
	// A fixed 50ms history interval makes each budget an explicit physical history.
	packedConfig[10 * 4 + 2] = representative ? 2 : 3;
	config.write(packedConfig);
	particles.write(packing.packParticles(agents, scene, 1));
	measured.write(metricData);
	species.write(packing.packSpecies(scene));
	history.write(historyData);
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function render(name, population, segments, timed = true) {
	const variant = variants[name];
	const submitted = frame(gpu, (f) =>
		f.pass(
			{
				target: stage,
				clear: [0.0006, 0.0009, 0.0015, 1],
				clearDepth: 1,
				...(timed ? { timer: renderTimer.span(name) } : {})
			},
			(p) => {
				if (activeWorld === 'sphere') p.draw(shell);
				if (segments && name === 'production') {
					for (const range of activeRanges) {
						const actualSegments = Math.min(
							segments,
							1 + Math.max(0, Math.ceil((range.seconds - 0.018) / activeSampleDt))
						);
						if (range.instances > 0)
							p.draw(variant.trail, {
								instances: range.instances,
								firstInstance: range.firstInstance,
								indices: actualSegments * 6
							});
					}
				} else if (segments)
					p.draw(variant.trail, {
						instances: name === 'strip' ? population * segments : population,
						vertices: name === 'strip' ? 4 : segments * 6,
						...(name === 'indexed' ? { indices: segments * 6 } : {})
					});
				p.draw(variant.body, { instances: population });
			}
		)
	);
	await Promise.all([submitted.done, gpu.gpu.queue.onSubmittedWorkDone()]);
	await gpu.settled();
}
try {
	await Promise.all([
		body.compile(stage),
		bodyFast.compile(stage),
		shell.compile(stage),
		...Object.values(variants).map((v) => v.trail.compile(stage))
	]);
	for (const population of populations)
		for (const world of worlds)
			for (const cluster of distributions)
				for (const segments of budgets) {
					setCase(population, world, cluster, segments);
					const samples = Object.fromEntries(Object.keys(variants).map((name) => [name, []]));
					const unsubscribe = renderTimer.onResults((spans) => {
						for (const [name, value] of Object.entries(spans)) samples[name].push(value);
					});
					for (let repeat = 0; repeat < 20; repeat++)
						for (const name of Object.keys(variants)) await render(name, population, segments);
					for (const values of Object.values(samples)) values.length = 0;
					for (let repeat = 0; repeat < 24; repeat++)
						for (const name of repeat % 2 ? Object.keys(variants).reverse() : Object.keys(variants))
							await render(name, population, segments);
					unsubscribe();
					await render('baseline', population, segments, false);
					const reference = await stage.color.readFloats({ mipLevel: 0, region: 'all' });
					const comparisons = {};
					for (const name of ['guarded', 'strip', 'indexed', 'production']) {
						await render(name, population, segments, false);
						const pixels = await stage.color.readFloats({ mipLevel: 0, region: 'all' });
						let changed = 0,
							maxError = 0,
							sumError = 0;
						for (let i = 0; i < pixels.length; i++) {
							const error = Math.abs(pixels[i] - reference[i]);
							if (error) changed++;
							maxError = Math.max(maxError, error);
							sumError += error;
						}
						comparisons[name] = {
							changedChannels: changed,
							maxError,
							meanError: sumError / pixels.length
						};
						if (name === 'guarded')
							assert.equal(changed, 0, 'guarded shader image must be bitwise identical');
						else
							assert.ok(
								maxError <= 0.004,
								`strip retains Float16 image within interpolation/blend tolerance: ${maxError}`
							);
					}
					const row = {
						population,
						world,
						cluster,
						segments,
						baselineVertices: population * (36 + segments * 6),
						stripVertices: population * (36 + segments * 4),
						gpuMs: Object.fromEntries(
							Object.entries(samples).map(([name, values]) => [name, median(values)])
						),
						samples: Object.fromEntries(
							Object.entries(samples).map(([name, values]) => [name, values.length])
						),
						rawGpuSamples: samples,
						comparisons
					};
					results.cases.push(row);
					console.log(JSON.stringify(row));
					await writeFile(resultFile, JSON.stringify(results, null, 2));
				}
	assert.deepEqual(errors, []);
} finally {
	renderTimer.dispose();
	for (const resource of owned) resource.destroy();
	stage.color.destroy();
	stage.depth.destroy();
	gpu.dispose();
}
