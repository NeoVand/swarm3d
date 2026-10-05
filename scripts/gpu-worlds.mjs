import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { init, compute, draw, frame, target } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

// Geometry/visibility gates for all solid worlds and both sides of surface skins.
const require = createRequire(import.meta.url),
	root = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [root] })).href
);
const { PNG } = await import(pathToFileURL(require.resolve('pngjs', { paths: [root] })).href);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing, surfaceRender;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
	surfaceRender = await vite.ssrLoadModule('/src/lib/gpu/surface-render.ts');
} finally {
	await vite.close();
}
const shaders = Object.fromEntries(
	await Promise.all(
		['grid', 'simulate', 'metrics', 'boids', 'trails', 'world'].map(async (name) => [
			name,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`) })).wgsl
		])
	)
);
const gpu = await init({
	requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxStorageBuffersInVertexStage: 5 }
});
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const owned = [];
const alloc = (label, size) => {
	const b = gpu.device.createBuffer({
		label,
		size: Math.max(16, size),
		usage: ['storage', 'copy_dst', 'copy_src']
	});
	owned.push(b);
	return b;
};
const config = alloc('solid config', 16384),
	particles = [alloc('state0', 128 * 64), alloc('state1', 128 * 64)],
	metrics = [alloc('metric0', 128 * 64), alloc('metric1', 128 * 64)],
	species = alloc('species', 1024),
	pairRules = alloc('pair rules', 16),
	grid = alloc('grid', 65536 * 12),
	indices = alloc('indices', 128 * 4),
	blocks = alloc('blocks', 256 * 4);
const history = alloc('surface trail history', 64 * packing.HISTORY_SAMPLE_BYTES);
const entries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const kernels = Object.fromEntries(
	entries.map((entry) => [entry, compute(gpu, shaders.grid, { entry })])
);
const simulate = compute(gpu, shaders.simulate, { entry: 'simulate' }),
	measure = compute(gpu, shaders.metrics, { entry: 'measure' });
const stage = target(gpu, { size: [400, 320], format: 'rgba8unorm', depth: true });
const setup = (world, agents) => {
	const scene = model.createDefaultScene();
	scene.world = world;
	scene.species = [scene.species[0]];
	scene.speciesRules = [];
	Object.assign(scene.species[0], {
		population: agents.length,
		size: 0.12,
		force: 0,
		alignment: 0,
		cohesion: 0,
		separation: 0,
		perception: 2,
		cruiseSpeed: 0,
		speed: 12
	});
	scene.species[0].rebels.fraction = 0;
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.species[0].visual.lightness.enabled = false;
	agents = agents.map((a, i) => ({
		id: i + 1,
		birth: i + 1,
		speciesKey: scene.species[0].key,
		...a
	}));
	const state = packing.packParticles(agents, scene, 1);
	particles.forEach((p) => p.write(state));
	species.write(packing.packSpecies(scene));
	pairRules.write(packing.packPairRules(scene));
	metrics.forEach((m) => m.write(new Float32Array(128 * 16)));
	return { scene, agents };
};
const configure = (scene, count, tick = 0) =>
	config.write(
		packing.packConfig(scene, {
			population: count,
			tick,
			historyHead: 0,
			validHistory: 1,
			smoothingAlpha: 1
		})
	);
const index = (scene, side, count) => {
	const g = packing.gridDefinition(scene),
		resources = { config, particles: particles[side], grid, indices, blocks };
	const counts = [
		Math.ceil(g.count / 256),
		Math.ceil(count / 256),
		Math.ceil(g.count / 256),
		1,
		Math.ceil(g.count / 256),
		Math.ceil(count / 256)
	];
	entries.forEach((entry, i) => {
		kernels[entry].set(resources);
		kernels[entry].dispatch(counts[i]);
	});
};
const measured = (side, count) => {
	measure.set({
		config,
		particles: particles[side],
		previousMetrics: metrics[1 - side],
		nextMetrics: metrics[side],
		grid,
		indices,
		species
	});
	measure.dispatch(Math.ceil(count / 128));
};
const worlds = [
	{ kind: 'volume', shape: 'sphere', radius: 6 },
	{ kind: 'volume', shape: 'cylinder', radius: 6, halfHeight: 8 },
	{ kind: 'volume', shape: 'torus', majorRadius: 16, tubeRadius: 6 }
];
const cameraBlock = (eye, look = [0, 0, 0]) => {
	const c = perspectiveCamera({
		fov: 42,
		aspect: 1.25,
		position: eye,
		target: look,
		near: 0.05,
		far: 200
	});
	return {
		viewProjection: c.viewProjection,
		position: [...eye, 1],
		right: [1, 0, 0, 1.25],
		up: [0, 1, 0, 320]
	};
};
const bodies = draw(gpu, {
	shader: shaders.boids,
	vertices: 36,
	depth: { write: true },
	set: {
		config,
		particles: particles[0],
		metrics: metrics[0],
		species,
		camera: cameraBlock([30, 18, 32])
	}
});
const shell = draw(gpu, {
	shader: shaders.world,
	entry: { vertex: 'vs_shell', fragment: 'fs_shell' },
	vertices: 10800,
	writeMask: [],
	depth: { write: true },
	set: { config, camera: cameraBlock([30, 18, 32]) }
});
const guides = draw(gpu, {
	shader: shaders.world,
	vertices: 6912,
	depth: { write: false },
	blend: 'alpha',
	set: { config, camera: cameraBlock([30, 18, 32]) }
});
const trail = draw(gpu, {
	shader: shaders.trails,
	vertices: 12,
	instances: 1,
	depth: { write: false },
	blend: 'premultiplied',
	set: {
		config,
		particles: particles[0],
		metrics: metrics[0],
		species,
		history,
		camera: cameraBlock([30, 18, 32])
	}
});
const render = async (scene, eye, look, { skin = false, body = false, wake = false } = {}) => {
	const camera = cameraBlock(eye, look);
	bodies.set({ camera });
	trail.set({ camera });
	shell.set({ camera });
	guides.set({ camera });
	frame(gpu, (f) =>
		f.pass({ target: stage, clear: [0, 0, 0, 1], clearDepth: 1 }, (p) => {
			if (skin) p.draw(shell, { vertices: scene.world.shape === 'torus' ? 55296 : 10800 });
			p.draw(guides);
			if (body) p.draw(bodies, { instances: 1 });
			if (wake) p.draw(trail);
		})
	);
	const pixels = await stage.color.read({ mipLevel: 0, region: 'all' });
	let colored = 0;
	for (let i = 0; i < pixels.length; i += 4)
		if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 6) colored++;
	return {
		pixels,
		colored,
		energy: pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0)
	};
};
await mkdir('.cache', { recursive: true });
try {
	// Exercise the production ribbon and coverage functions with a known segment.
	// Summed radiance must remain constant as subpixel camera pans cross raster rows.
	const probeOutput = shaders.world.match(/struct (\w*GuideOutput)\s*\{/)[1];
	const probeVertex = shaders.world.match(/fn (\w*guide_vertex)\(/)[1];
	const probeConfig = shaders.world.match(/@binding\(0\) var<storage, read> (\w+):/)[1];
	const qualityProbe = draw(gpu, {
		shader: `${shaders.world}
@vertex fn vs_quality(@builtin(vertex_index) index:u32)->${probeOutput} {
 return ${probeVertex}(${probeConfig}[16].xyz,${probeConfig}[17].xyz,index,${probeConfig}[16].w,vec4f(1.0));
}`,
		entry: { vertex: 'vs_quality', fragment: 'fs_main' },
		vertices: 6,
		depth: { write: false },
		blend: 'alpha',
		set: { config, camera: cameraBlock([0, 0, 12]) }
	});
	const probeSegment = async (a, b, halfWidth, phase) => {
		const values = new Float32Array(72);
		values.set([...a, halfWidth, ...b, 0], 64);
		config.write(values);
		const dy = (phase * 24 * Math.tan((21 * Math.PI) / 180)) / 320;
		qualityProbe.set({ camera: cameraBlock([0, dy, 12], [0, dy, 0]) });
		frame(gpu, (f) =>
			f.pass({ target: stage, clear: [0, 0, 0, 1], clearDepth: 1 }, (p) => p.draw(qualityProbe))
		);
		const pixels = await stage.color.read({ mipLevel: 0, region: 'all' });
		return pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0);
	};
	for (const [a, b, label] of [
		[[-4, 0, 0], [4, 0, 0], 'horizontal'],
		[[-4, -2, 0], [4, 2, 0], 'diagonal'],
		[[-4, -1, -2], [4, 1, 2], 'perspective']
	]) {
		for (const halfWidth of [0.4, 0.65]) {
			const energy = [];
			for (let phase = 0; phase < 8; phase++)
				energy.push(await probeSegment(a, b, halfWidth, phase / 8));
			const variation =
				(Math.max(...energy) - Math.min(...energy)) /
				(energy.reduce((a, b) => a + b) / energy.length);
			assert.ok(
				variation < 0.025,
				`${label} ${halfWidth * 2}px line has stable subpixel radiance, observed ${variation}`
			);
			console.log(
				`PASS ${label} ${halfWidth * 2}px line:subpixel radiance variation ${(variation * 100).toFixed(2)}%`
			);
		}
	}
	assert.equal(
		await probeSegment([-1, 0, 13], [1, 0, 14], 0.65, 0),
		0,
		'wholly behind-eye guide is clipped'
	);
	const crossingEnergy = await probeSegment([-0.02, 0, 11.98], [1, 0, 9], 0.65, 0);
	assert.ok(
		crossingEnergy > 0 && crossingEnergy < 400 * 320 * 255 * 0.02,
		'near-plane crossing stays a thin guide'
	);
	console.log('PASS guide near-plane clipping without behind-eye or full-screen ribbons');
	for (const world of worlds) {
		const origin = world.shape === 'torus' ? [21.85, 0, 0] : [5.85, 0, 0];
		const { scene, agents } = setup(world, [
			{ position: origin, velocity: [8, 0, 0] },
			{ position: [origin[0] - 0.5, 0.2, 0.3], velocity: [0, 1, 2] }
		]);
		configure(scene, 2);
		index(scene, 0, 2);
		measured(0, 2);
		const measuredBefore = new Float32Array(await metrics[0].read(128));
		const reference = model.measureAllPairs(scene, agents);
		assert.ok(
			Math.abs(measuredBefore[4] - reference[0].density) < 1e-6,
			`${world.shape} has 3D density`
		);
		let side = 0;
		for (let tick = 1; tick <= 120; tick++) {
			configure(scene, 2, tick);
			simulate.set({
				config,
				current: particles[side],
				next: particles[1 - side],
				grid,
				indices,
				metrics: metrics[side],
				species,
				pairRules
			});
			simulate.dispatch(1);
			side = 1 - side;
			index(scene, side, 2);
			measured(side, 2);
			if (tick === 1) {
				const actual = packing.unpackParticles(await particles[side].read(128), scene, 2);
				agents.forEach((agent, i) => {
					const expected = model.worldAdvance(
						world,
						agent.position,
						agent.velocity,
						scene.dynamics.fixedDt,
						0.12
					);
					for (let axis = 0; axis < 3; axis++) {
						assert.ok(
							Math.abs(actual[i].position[axis] - expected.position[axis]) < 1e-5,
							`${world.shape} GPU/CPU contact position axis${axis}`
						);
						assert.ok(
							Math.abs(actual[i].velocity[axis] - expected.velocity[axis]) < 1e-5,
							`${world.shape} GPU/CPU contact velocity axis${axis}`
						);
					}
				});
			}
		}
		const states = packing.unpackParticles(await particles[side].read(128), scene, 2);
		states.forEach((agent) =>
			assert.ok(
				model.volumeContact(world, agent.position, 0.12).distance < 1e-5,
				`${world.shape} never escapes its solid boundary`
			)
		);
		assert.ok(
			Math.abs(Math.hypot(...states[0].velocity) - 8) < 1e-4,
			`${world.shape} reflection preserves speed`
		);
		assert.ok(
			Math.abs(states[1].velocity[1]) > 0.5,
			`${world.shape} retains three-dimensional velocities`
		);
		console.log(`PASS solid ${world.shape}:120 GPU ticks, containment, speed, 3D metrics`);
	}
	const domains = [
		{ kind: 'volume', shape: 'box', halfExtents: [8, 6, 8], boundaries: 'reflect' },
		...worlds,
		{ kind: 'surface', shape: 'sphere', radius: 6 },
		{ kind: 'surface', shape: 'cylinder', radius: 6, halfHeight: 8 },
		{ kind: 'surface', shape: 'plane', halfExtents: [8, 8], boundaries: 'reflect' },
		{ kind: 'surface', shape: 'torus', majorRadius: 16, tubeRadius: 6 }
	];
	for (const world of domains) {
		const { scene } = setup(world, [{ position: [0, 0, 0], velocity: [1, 0, 0] }]);
		const eye = world.shape === 'torus' ? [40, 32, 48] : [24, 18, 28];
		scene.visual.showBoundary = false;
		scene.visual.showGrid = false;
		configure(scene, 0);
		assert.equal(
			(await render(scene, eye, [0, 0, 0])).colored,
			0,
			`${world.kind}/${world.shape} defaults have no guides`
		);
		scene.visual.showBoundary = true;
		configure(scene, 0);
		const boundary = await render(scene, eye, [0, 0, 0]);
		assert.ok(boundary.colored > 50, `${world.kind}/${world.shape} boundary is visible`);
		scene.visual.showBoundary = false;
		scene.visual.showGrid = true;
		configure(scene, 0);
		const gridImage = await render(scene, eye, [0, 0, 0]);
		assert.ok(gridImage.colored > 50, `${world.kind}/${world.shape} grid works independently`);
		const png = new PNG({ width: 400, height: 320 });
		png.data.set(gridImage.pixels);
		await writeFile(`.cache/world-grid-${world.kind}-${world.shape}.png`, PNG.sync.write(png));
		console.log(
			`PASS ${world.kind}/${world.shape} separate boundary and grid:${boundary.colored}/${gridImage.colored} pixels`
		);
		for (const mode of ['boundary', 'grid']) {
			scene.visual.showBoundary = mode === 'boundary';
			scene.visual.showGrid = mode === 'grid';
			configure(scene, 0);
			const energy = [];
			// Pan both eye and look point together, traversing one physical pixel.
			const unitsPerPixel = (Math.hypot(...eye) * 2 * Math.tan((21 * Math.PI) / 180)) / 320;
			for (let phase = 0; phase < 8; phase++) {
				const shift = (phase / 8) * unitsPerPixel;
				const moved = await render(scene, [eye[0] + shift, eye[1], eye[2]], [shift, 0, 0], {
					skin: world.kind === 'surface'
				});
				energy.push(moved.energy);
			}
			const variation =
				(Math.max(...energy) - Math.min(...energy)) /
				(energy.reduce((a, b) => a + b) / energy.length);
			assert.ok(
				variation < 0.06,
				`${world.kind}/${world.shape} ${mode} remains stable during subpixel pan, observed ${variation}`
			);
			console.log(
				`PASS ${world.kind}/${world.shape} ${mode}:motion radiance variation ${(variation * 100).toFixed(2)}%`
			);
		}
	}
	for (const [world, eye, look] of [
		[{ kind: 'surface', shape: 'sphere', radius: 6 }, [0.3, 0.2, 0.1], [0, 0, 6]],
		[
			{ kind: 'surface', shape: 'cylinder', radius: 6, halfHeight: 8 },
			[0.5, 0.2, 0.3],
			[6, 0.2, 0]
		],
		[{ kind: 'surface', shape: 'torus', majorRadius: 16, tubeRadius: 6 }, [20, 0, 0], [22, 0, 0]]
	]) {
		const { scene } = setup(world, [{ position: [0, 0, 0], velocity: [1, 0, 0] }]);
		scene.visual.showBoundary = true;
		scene.visual.showGrid = true;
		configure(scene, 0);
		const energy = [];
		for (let phase = 0; phase < 8; phase++) {
			const shift = (phase / 8) * 0.01;
			const moved = await render(
				scene,
				[eye[0], eye[1] + shift, eye[2]],
				[look[0], look[1] + shift, look[2]],
				{ skin: true }
			);
			energy.push(moved.energy);
		}
		const variation =
			(Math.max(...energy) - Math.min(...energy)) /
			(energy.reduce((a, b) => a + b) / energy.length);
		assert.ok(Math.min(...energy) > 1000, `${world.shape} guide is visible from inside`);
		assert.ok(
			variation < 0.06,
			`${world.shape} inside guide remains stable with skin occlusion, observed ${variation}`
		);
		console.log(
			`PASS ${world.shape} inside guide:motion radiance variation ${(variation * 100).toFixed(2)}%`
		);
	}
	for (const shape of ['sphere', 'cylinder']) {
		const world =
			shape === 'sphere'
				? { kind: 'surface', shape, radius: 6 }
				: { kind: 'surface', shape, radius: 6, halfHeight: 8 };
		const { scene } = setup(world, [{ position: [0, 0, 6], velocity: [1, 0, 0] }]);
		scene.visual.showBoundary = false;
		scene.visual.showGrid = false;
		configure(scene, 1);
		for (const [view, eye] of [
			['outside', [0, 0, 15]],
			['inside', [0, 0, 0]]
		]) {
			const image = await render(scene, eye, [0, 0, 6], { skin: true, body: true });
			assert.ok(image.colored > 10, `${shape} body visible from ${view}`);
			const png = new PNG({ width: 400, height: 320 });
			png.data.set(image.pixels);
			await writeFile(`.cache/world-${shape}-${view}.png`, PNG.sync.write(png));
			console.log(
				`PASS ${shape} ${view}:view-facing body clears depth skin:${image.colored} pixels`
			);
			const records = new Float32Array(64 * 8);
			for (let slot = 0; slot < 64; slot++) {
				const angle = slot === 0 ? 0.08 : slot === 63 ? 0.16 : 0.24;
				records.set([6 * Math.sin(angle), 0, 6 * Math.cos(angle), 1], slot * 4);
				records.set([0.4, 0.8, 0.8, 1], 64 * 4 + slot * 4);
			}
			history.write(records);
			config.write(
				packing.packConfig(scene, {
					population: 1,
					tick: 3,
					historyHead: 0,
					validHistory: 3,
					historyElapsed: 1 / 60,
					smoothingAlpha: 1
				})
			);
			const wake = await render(scene, eye, [0, 0, 6], { skin: true, wake: true });
			assert.ok(wake.colored > 10, `${shape} trail visible from ${view}`);
			console.log(`PASS ${shape} ${view}:history wake clears depth skin:${wake.colored} pixels`);
			configure(scene, 1);
		}
	}
	// Avoid meridian-aligned fixtures: analytic skins sit outside polygon face
	// chords by a sagitta that exceeds ordinary tiny-body/trail lift at R20.
	for (const shape of ['sphere', 'cylinder']) {
		const world =
			shape === 'sphere'
				? { kind: 'surface', shape, radius: 20 }
				: { kind: 'surface', shape, radius: 20, halfHeight: 24 };
		const angle = Math.PI / 60,
			latitude = Math.PI / 4;
		const point =
			shape === 'cylinder'
				? [20 * Math.cos(angle), 0, 20 * Math.sin(angle)]
				: [
						20 * Math.sin(latitude) * Math.cos(angle),
						20 * Math.cos(latitude),
						20 * Math.sin(latitude) * Math.sin(angle)
					];
		const { scene } = setup(world, [{ position: point, velocity: [0, 0, 1] }]);
		const eye = point.map((v, i) => v * 0.98 + (i === 2 ? 0.2 : 0));
		for (const size of [0.14, 0.01]) {
			scene.species[0].size = size;
			species.write(packing.packSpecies(scene));
			configure(scene, 1);
			const image = await render(scene, eye, point, { skin: true, body: true });
			assert.ok(image.colored > 4, `${shape} R20 size${size} inside oblique mid-face body visible`);
			console.log(
				`PASS ${shape} R20 mid-face size${size}:inside visibility:${image.colored}pixels`
			);
		}
		scene.species[0].size = 0.14;
		species.write(packing.packSpecies(scene));
		const records = new Float32Array(64 * 8);
		for (let slot = 0; slot < 64; slot++) {
			const phi = angle - (slot === 0 ? 0.004 : slot === 63 ? 0.012 : 0.02);
			const p =
				shape === 'cylinder'
					? [20 * Math.cos(phi), 0, 20 * Math.sin(phi)]
					: [
							20 * Math.sin(latitude) * Math.cos(phi),
							20 * Math.cos(latitude),
							20 * Math.sin(latitude) * Math.sin(phi)
						];
			records.set([...p, 1], slot * 4);
			records.set([0.4, 0.8, 0.8, 1], 64 * 4 + slot * 4);
		}
		history.write(records);
		config.write(
			packing.packConfig(scene, {
				population: 1,
				tick: 3,
				historyHead: 0,
				validHistory: 3,
				historyElapsed: 1 / 60,
				smoothingAlpha: 1
			})
		);
		const wake = await render(scene, eye, point, { skin: true, wake: true });
		assert.ok(wake.colored > 8, `${shape} R20 inside mid-face wake visible`);
		console.log(`PASS ${shape} R20 mid-face:inside wake:${wake.colored}pixels`);
	}
	// Picking must agree numerically with the rendered center, including the
	// extremely close eye cap and the inward facet clearance on every surface.
	const fixtures = [
		{
			world: { kind: 'surface', shape: 'sphere', radius: 20 },
			point: [19.9, 0, Math.sqrt(400 - 19.9 ** 2)],
			kind: 1
		},
		{
			world: { kind: 'surface', shape: 'cylinder', radius: 20, halfHeight: 24 },
			point: [19.9, 2, Math.sqrt(400 - 19.9 ** 2)],
			kind: 3
		},
		{
			world: { kind: 'surface', shape: 'torus', majorRadius: 40, tubeRadius: 20 },
			point: [60, 0, 0],
			kind: 4
		}
	];
	const inputs = [],
		expected = [];
	for (const item of fixtures)
		for (const distance of [-4, -0.01, 4, 0.01]) {
			const normal = model.worldNormal(item.world, item.point),
				eye = item.point.map((v, i) => v + normal[i] * distance);
			inputs.push(
				[...item.point, item.kind],
				[...eye, 0.14],
				[item.world.majorRadius ?? 0, 0, 0, 0]
			);
			expected.push(surfaceRender.agentRenderCenter(item.world, item.point, 0.14, eye));
		}
	const probeSource = `import { body_center } from "../src/lib/gpu/shaders/common.wgsl";
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id:vec3u){
 let p=input[id.x*3u];let eye=input[id.x*3u+1u];let major=input[id.x*3u+2u].x;
 result[id.x]=vec4f(body_center(p.xyz,p.w,major,eye.xyz,eye.w),1.0);
}`;
	await writeFile('.cache/world-center-probe.wgsl', probeSource);
	const probeShader = (await resolveShader({ entry: resolve('.cache/world-center-probe.wgsl') }))
		.wgsl;
	const probeInput = alloc('center probe input', inputs.length * 16),
		probeResult = alloc('center probe result', expected.length * 16);
	probeInput.write(new Float32Array(inputs.flat()));
	const probe = compute(gpu, probeShader, { entry: 'probe' });
	probe.set({ input: probeInput, result: probeResult });
	probe.dispatch(expected.length);
	const result = new Float32Array(await probeResult.read(expected.length * 16));
	expected.forEach((point, i) =>
		point.forEach((v, axis) =>
			assert.ok(
				Math.abs(result[i * 4 + axis] - v) < 1e-5,
				`rendered center/picking CPU GPU agreement case${i}axis${axis}`
			)
		)
	);
	console.log(
		'PASS 12 surface render center CPU/GPU agreement cases, including very close inside/outside eyes'
	);
	await gpu.settled();
	assert.deepEqual(errors, []);
	console.log('PASS all world geometry/rendering gates without GPU errors');
} finally {
	owned.forEach((b) => b.destroy());
	gpu.dispose();
}
