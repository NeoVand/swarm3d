import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';
import { init, compute, draw, effect, frame, sampler, target } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

// Native presentation gates, using production shader entry points and resources.
// No animation, benchmark or browser runs concurrently with this isolated script.
const require = createRequire(import.meta.url);
const dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing, trailRendering;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
	trailRendering = await vite.ssrLoadModule('/src/lib/gpu/trail-render.ts');
} finally {
	await vite.close();
}
const shaders = Object.fromEntries(
	await Promise.all(
		['boids', 'trails', 'history', 'world', 'presentation'].map(async (name) => [
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
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const owned = [];
const allocate = (label, size) => {
	const b = gpu.device.createBuffer({
		label,
		size: Math.max(16, size),
		usage: ['storage', 'copy_src', 'copy_dst']
	});
	owned.push(b);
	return b;
};
const config = allocate('presentation config', 16384);
const particles = allocate('presentation particles', 3 * packing.PARTICLE_BYTES);
const metrics = allocate('presentation measured values', 3 * packing.METRIC_BYTES);
const species = allocate('presentation species', 2 * packing.SPECIES_ROWS * 16);
const HISTORY_CAPACITY = 3;
const history = allocate(
	'historical positions and linear colors',
	HISTORY_CAPACITY * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES
);
const stage = target(gpu, { size: [256, 192], format: 'rgba16float', depth: true });
const output = target(gpu, { size: stage.size, format: 'rgba8unorm' });
const camera = perspectiveCamera({
	fov: 42,
	aspect: 256 / 192,
	position: [3, 2, 7],
	target: [0, 0, 0],
	near: 0.05,
	far: 200
});
const block = () => ({
	viewProjection: camera.viewProjection,
	position: [...camera.worldPosition, 1],
	right: [1, 0, 0, 0],
	up: [0, 1, 0, 0]
});
const body = draw(gpu, {
	shader: shaders.boids,
	vertices: 36,
	depth: { write: true },
	set: { config, particles, metrics, species, camera: block() }
});
const trail = draw(gpu, {
	shader: shaders.trails,
	vertices: 12,
	depth: { write: false },
	blend: 'premultiplied',
	set: { config, particles, metrics, species, history, camera: block() }
});
const trailPattern = trailRendering.trailQuadIndices();
const trailIndices = gpu.device.createBuffer({
	label: 'production shared trail quad indices',
	size: trailPattern.byteLength,
	usage: ['index', 'copy_dst']
});
owned.push(trailIndices);
trailIndices.write(trailPattern);
const indexedTrail = draw(gpu, {
	shader: shaders.trails,
	entry: { vertex: 'vs_indexed', fragment: 'fs_main' },
	geometry: {
		indexBuffer: trailIndices.gpu,
		indexFormat: 'uint16',
		indexCount: trailPattern.length
	},
	depth: { write: false },
	blend: 'premultiplied',
	set: { config, particles, metrics, species, history, camera: block() }
});
const shell = draw(gpu, {
	shader: shaders.world,
	entry: { vertex: 'vs_shell', fragment: 'fs_shell' },
	vertices: 10800,
	writeMask: [],
	depth: { write: true },
	set: { config, camera: block() }
});
const record = compute(gpu, shaders.history, { entry: 'write_history' }).set({
	config,
	particles,
	history,
	metrics,
	species
});
const imageSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
const present = effect(gpu, shaders.presentation, {
	set: { image: stage, imageSampler, glow: stage, presentation: { bloom: 0, exposure: 1 } }
});
const baseScene = model.createDefaultScene();
baseScene.species = [baseScene.species[0]];
baseScene.species[0].population = 1;
baseScene.species[0].size = 0.8;
baseScene.species[0].visual.hsl = [0.47, 0.82, 0.56];
for (const name of ['hue', 'saturation', 'lightness'])
	baseScene.species[0].visual[name].enabled = false;
baseScene.species[0].trail = { length: 3, width: 0.65, opacity: 1 };
baseScene.visual.showBoundary = false;
baseScene.visual.bloom = false;
const agent = (position = [0, 0, 0]) => ({
	id: 1,
	birth: 1,
	speciesKey: baseScene.species[0].key,
	position,
	velocity: [0, 0, 1]
});
const measured = new Float32Array(packing.METRIC_BYTES / 4);
const linear = {
	points: [
		[0, 0],
		[1, 1]
	]
};
const map = (source, range, strength = 1) => ({
	enabled: true,
	source,
	range,
	strength,
	curve: linear
});
function configure(scene, position = [0, 0, 0], head = 0, valid = 1, sample = false) {
	config.write(
		packing.packConfig(scene, {
			population: 1,
			historyCapacity: HISTORY_CAPACITY,
			tick: 77,
			historyHead: head,
			validHistory: valid,
			smoothingAlpha: 1,
			historyElapsed: 0.05,
			sampleHistory: sample
		})
	);
	particles.write(packing.packParticles([agent(position)], scene, 1));
	species.write(packing.packSpecies(scene));
	metrics.write(measured);
	body.set({ camera: block() });
	trail.set({ camera: block() });
	indexedTrail.set({ camera: block() });
	shell.set({ camera: block() });
}
async function render({
	bodies = true,
	trails = false,
	enclosure = false,
	vertices = 12,
	indexed = true,
	instances = 1,
	trailRanges = null,
	clear = [0.0006, 0.0009, 0.0015, 0]
} = {}) {
	const submitted = frame(gpu, (f) =>
		f.pass({ target: stage, clear, clearDepth: 1 }, (p) => {
			if (enclosure) p.draw(shell);
			if (trails)
				if (indexed && trailRanges)
					for (const range of trailRanges)
						p.draw(indexedTrail, {
							indices: range.segments * 6,
							firstInstance: range.firstInstance,
							instances: range.instances
						});
				else if (indexed) p.draw(indexedTrail, { indices: vertices, instances });
				else p.draw(trail, { vertices, instances });
			if (bodies) p.draw(body, { instances: 1 });
		})
	);
	await Promise.all([submitted.done, gpu.gpu.queue.onSubmittedWorkDone()]);
	return stage.color.readFloats({ mipLevel: 0, region: 'all' });
}
const srgbLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const close = (a, b, message, tolerance = 3e-6) =>
	assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
async function stored(slot) {
	const floats = new Float32Array(await history.read(history.options.size));
	return [
		...floats.subarray(
			(HISTORY_CAPACITY * packing.HISTORY_SAMPLES + slot) * 4,
			(HISTORY_CAPACITY * packing.HISTORY_SAMPLES + slot) * 4 + 4
		)
	];
}
async function sample(scene, slot, position) {
	configure(scene, position, slot, slot + 1, true);
	record.dispatch(1);
	await gpu.gpu.queue.onSubmittedWorkDone();
	return stored(slot);
}

// Small dependency-free PNG writer for visual inspection of native readback.
function pngChunk(type, data) {
	const kind = Buffer.from(type),
		body = Buffer.concat([kind, data]);
	let crc = 0xffffffff;
	for (const byte of body) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	const size = Buffer.alloc(4),
		checksum = Buffer.alloc(4);
	size.writeUInt32BE(data.length);
	checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([size, body, checksum]);
}
async function snapshot(name) {
	await frame(gpu, (f) => f.pass(output, present)).done;
	await gpu.gpu.queue.onSubmittedWorkDone();
	const rgba = await output.color.read({ mipLevel: 0, region: 'all' });
	const [width, height] = output.size;
	const rows = Buffer.alloc(height * (width * 4 + 1));
	for (let y = 0; y < height; y++)
		rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	await mkdir('.cache/rendering', { recursive: true });
	await writeFile(
		`.cache/rendering/${name}.png`,
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			pngChunk('IHDR', header),
			pngChunk('IDAT', deflateSync(rows)),
			pngChunk('IEND', Buffer.alloc(0))
		])
	);
}

try {
	await Promise.all([
		body.compile(stage),
		trail.compile(stage),
		indexedTrail.compile(stage),
		shell.compile(stage),
		present.compile(output)
	]);
	let baseline;
	for (const palette of ['rainbow', 'bands', 'ocean', 'chrome', 'mono']) {
		const scene = structuredClone(baseScene);
		scene.visual.palette = palette;
		configure(scene);
		const pixels = await render();
		if (baseline) assert.deepEqual(pixels, baseline, `static species HSL bypasses ${palette}`);
		else baseline = pixels;
		const color = await sample(scene, 0, [0, 0, 0]);
		assert.equal(color[3], 1, 'history color valid flag');
	}
	console.log('PASS static picked HSL is unchanged by all five palettes, body/history share color');
	for (const palette of ['rainbow', 'bands', 'ocean', 'chrome', 'mono']) {
		const scene = structuredClone(baseScene);
		scene.visual.palette = palette;
		let previousPixels;
		for (const [hue, rgb] of [
			[0, [1, 0, 0]],
			[1 / 3, [0, 1, 0]],
			[2 / 3, [0, 0, 1]]
		]) {
			scene.species[0].visual.hsl = [hue, 1, 0.5];
			configure(scene);
			const pixels = await render();
			if (previousPixels)
				assert.notDeepEqual(pixels, previousPixels, `${palette} base Hue edits repaint bodies`);
			previousPixels = pixels;
			const color = await sample(scene, 0, [0, 0, 0]);
			for (let c = 0; c < 3; c++)
				close(color[c], rgb[c], `${palette} edited species Hue ${hue}, channel ${c}`);
			// Preparing a disabled metric does not replace the selected species color.
			scene.species[0].visual.hue = { ...map('speed', [0, 1]), enabled: false };
			configure(scene);
			assert.deepEqual(await render(), pixels, `${palette} disabled mapping keeps base Hue`);
			scene.species[0].visual.hue.source = 'constant';
		}
	}
	console.log(
		'PASS live species Hue edits update bodies/history, disabled mappings retain base Hue'
	);
	for (let index = 0; index < model.METRICS.length; index++) {
		const metric = model.METRICS[index];
		const scene = structuredClone(baseScene);
		scene.species[0].visual.hue = map(metric.id, metric.range);
		let previousColor;
		for (const response of [0.2, 0.8]) {
			measured.fill(0);
			measured[index] = metric.range[0] + response * (metric.range[1] - metric.range[0]);
			configure(scene);
			const mappedPixels = await render();
			const mappedColor = await sample(scene, 0, [0, 0, 0]);
			const reference = structuredClone(baseScene);
			reference.species[0].visual.hsl[0] = response;
			configure(reference);
			const referencePixels = await render();
			const referenceColor = await sample(reference, 0, [0, 0, 0]);
			for (let pixel = 0; pixel < mappedPixels.length; pixel++)
				close(mappedPixels[pixel], referencePixels[pixel], `${metric.id} mapped Hue body`, 0.001);
			for (let c = 0; c < 3; c++)
				close(mappedColor[c], referenceColor[c], `${metric.id} mapped Hue history channel ${c}`);
			if (previousColor)
				assert.notDeepEqual(mappedColor, previousColor, `${metric.id} Hue responds to measurement`);
			previousColor = mappedColor;
		}
	}
	measured.fill(0);
	console.log(
		'PASS all 15 Hue metrics change body/history colors and match normalized RGB references'
	);
	const nearEnd = 0.999;
	const bandsPhase = (nearEnd * 6 - 5 - 0.85) / 0.15;
	const bandsBlend = bandsPhase * bandsPhase * (3 - 2 * bandsPhase);
	const interpolateRgb = (a, b, weight) => a.map((value, c) => value + (b[c] - value) * weight);
	const paletteEndpoints = [
		{
			palette: 'rainbow',
			start: [1, 0, 0],
			end: [1, 0, 0],
			near: [1, 0, (1 - nearEnd) * 6]
		},
		{
			palette: 'bands',
			start: [0.9, 0.2, 0.3],
			end: [0.9, 0.2, 0.3],
			near: interpolateRgb([0.6, 0.3, 0.8], [0.9, 0.2, 0.3], bandsBlend)
		},
		{
			palette: 'ocean',
			start: [0.3, 0.42, 0.78],
			end: [0.3, 0.42, 0.78],
			near: interpolateRgb([0.65, 0.42, 0.65], [0.3, 0.42, 0.78], nearEnd * 6 - 5)
		},
		{
			palette: 'chrome',
			start: [0.2, 0.4, 0.9],
			end: [0.9, 0.2, 0.2],
			near: interpolateRgb([0.95, 0.6, 0.2], [0.9, 0.2, 0.2], nearEnd * 4 - 3)
		},
		{
			palette: 'mono',
			start: [0.4, 0.38, 0.36],
			end: [1, 0.95, 0.9],
			near: [1, 0.95, 0.9].map((value) => value * (0.4 + nearEnd * 0.6))
		}
	];
	for (const { palette, start, end, near } of paletteEndpoints) {
		const scene = structuredClone(baseScene);
		scene.visual.palette = palette;
		scene.species[0].visual.hsl = [0.47, 1, 0.5];
		scene.species[0].visual.hue = map('speed', [0, 1]);
		const colors = [];
		for (const [value, expected] of [
			[0, start],
			[nearEnd, near],
			[1, end]
		]) {
			measured[0] = value;
			const color = await sample(scene, 0, [0, 0, 0]);
			assert.equal(color[3], 1, `${palette} endpoint sample is valid`);
			for (let c = 0; c < 3; c++)
				close(color[c], srgbLinear(expected[c]), `${palette} mapped hue ${value} channel ${c}`);
			colors.push(color);
		}
		assert.ok(
			Math.max(...colors[1].slice(0, 3).map((value, c) => Math.abs(value - colors[2][c]))) < 0.012,
			`${palette} approaches its upper endpoint continuously`
		);
	}
	console.log('PASS all five mapped palettes retain correct endpoints and near-end interpolation');
	const mapped = structuredClone(baseScene);
	mapped.visual.palette = 'rainbow';
	mapped.species[0].visual.hue = map('center-orbit-angle', [0, 1]);
	mapped.species[0].visual.saturation = map('center-radial-speed', [-2, 2]);
	mapped.species[0].visual.lightness = map('speed-contrast', [0, 1]);
	measured[12] = 0.2;
	measured[13] = 1.2;
	measured[14] = 0.55;
	configure(mapped);
	const dynamic = await render();
	const constant = structuredClone(baseScene);
	constant.species[0].visual.hsl = [0.2, 0.8, 0.55];
	configure(constant);
	const staticPixels = await render();
	for (let i = 0; i < dynamic.length; i++)
		close(dynamic[i], staticPixels[i], 'three independent fourth-row metric channels', 0.001);
	console.log('PASS all three new real-flow metrics drive independent H/S/L channels');
	const chrome = structuredClone(baseScene);
	chrome.visual.palette = 'chrome';
	chrome.species[0].visual.hsl = [0.47, 1, 0.5];
	chrome.species[0].visual.hue = map('center-orbit-angle', [0, 1], 0.75);
	measured[12] = 0.96;
	const c1 = await sample(chrome, 0, [0, 0, 0]);
	measured[12] = 0.98;
	const c2 = await sample(chrome, 1, [0, 0, 0]);
	const expectedChrome = (value) => {
		const coordinate = 0.47 * 0.25 + value * 0.75,
			t = (coordinate - 0.75) * 4;
		return [0.95 * (1 - t) + 0.9 * t, 0.6 * (1 - t) + 0.2 * t, 0.2].map(srgbLinear);
	};
	for (let c = 0; c < 3; c++) {
		close(
			c1[c],
			expectedChrome(0.96)[c],
			'continuous palette coordinate before prior short-arc branch'
		);
		close(
			c2[c],
			expectedChrome(0.98)[c],
			'continuous palette coordinate after prior short-arc branch'
		);
	}
	assert.ok(
		Math.max(...c1.slice(0, 3).map((v, i) => Math.abs(v - c2[i]))) < 0.04,
		'small scalar hue change stays small under Chrome'
	);
	console.log(
		'PASS partial hue mapping is scalar-continuous and ramp brightness preserves legacy chroma'
	);
	for (const shape of ['arrow', 'cone', 'diamond', 'sphere', 'ribbon']) {
		const scene = structuredClone(baseScene);
		scene.species[0].body = shape;
		configure(scene);
		const pixels = await render();
		const values = [];
		for (let i = 0; i < pixels.length; i += 4)
			if (pixels[i + 3] > 0.5)
				values.push(pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722);
		values.sort((a, b) => a - b);
		assert.ok(values.length > 120, `${shape} has readable real 3D geometry`);
		const contrast =
			values[Math.floor(values.length * 0.95)] /
			Math.max(1e-7, values[Math.floor(values.length * 0.05)]);
		assert.ok(contrast > 1.08, `${shape} per-fragment shade/highlight variation (${contrast})`);
		await snapshot(`body-${shape}`);
		console.log(
			`PASS ${shape}: ${values.length} lit body pixels, shade contrast ${contrast.toFixed(2)}`
		);
	}
	camera.set({ position: [0, 0, 8] });
	camera.lookAt([0, 0, 0]);
	const historical = structuredClone(baseScene);
	historical.species[0].visual.hue = map('speed', [0, 4]);
	historical.species[0].visual.hsl = [0.1, 0.9, 0.6];
	measured.fill(0);
	measured[0] = 0.8;
	const oldColor = await sample(historical, 0, [-1.6, 0, 0]);
	measured[0] = 3.2;
	const newColor = await sample(historical, 1, [0, 0, 0]);
	assert.ok(
		Math.max(...oldColor.slice(0, 3).map((v, i) => Math.abs(v - newColor[i]))) > 0.2,
		'actual changing history stores distinct colors'
	);
	configure(historical, [1.6, 0, 0], 1, 2, false);
	const before = await render({ bodies: false, trails: true });
	assert.deepEqual(
		before,
		await render({ bodies: false, trails: true, indexed: false }),
		'indexed world-space historical gradients exactly match original triangles'
	);
	await snapshot('historical-gradient');
	const edited = structuredClone(historical);
	edited.visual.palette = 'chrome';
	edited.species[0].visual.hsl = [0.7, 0.5, 0.4];
	configure(edited, [1.6, 0, 0], 1, 2, false);
	const after = await render({ bodies: false, trails: true });
	assert.deepEqual(
		after,
		await render({ bodies: false, trails: true, indexed: false }),
		'indexed current head and retained old palette exactly match original triangles'
	);
	assert.deepEqual(
		await stored(0),
		oldColor,
		'later palette/species edits retain oldest sampled RGB'
	);
	assert.deepEqual(await stored(1), newColor, 'later edits retain newest sampled RGB');
	let preserved = 0,
		changedHead = 0;
	for (let y = 0; y < 192; y++)
		for (let x = 0; x < 256; x++) {
			const i = (y * 256 + x) * 4;
			if (before[i + 3] < 0.02) continue;
			if (x < 120) {
				for (let c = 0; c < 4; c++)
					assert.equal(after[i + c], before[i + c], 'old historical segment never repaints');
				preserved++;
			}
			if (
				x > 140 &&
				Math.abs(before[i] - after[i]) +
					Math.abs(before[i + 1] - after[i + 1]) +
					Math.abs(before[i + 2] - after[i + 2]) >
					0.01
			)
				changedHead++;
		}
	assert.ok(
		preserved > 100 && changedHead > 100,
		'retained past plus a visibly updated current head'
	);
	const centerIndex = (96 * 256 + 100) * 4,
		shoulderIndex = (90 * 256 + 100) * 4;
	assert.ok(
		before[centerIndex] + before[centerIndex + 1] + before[centerIndex + 2] >
			1.15 * (before[shoulderIndex] + before[shoulderIndex + 1] + before[shoulderIndex + 2]),
		'trail center is luminous relative to soft shoulders'
	);
	console.log(
		'PASS actual historical RGB gradient, palette-edit retention, current head color and soft luminous core'
	);
	// Newborn/migrated records can have absent/nonfinite RGB or stale generation
	// tokens. Index reuse must preserve fallback colors and skipped geometry.
	for (const [name, colorRecord, generation] of [
		['missing color', [0, 0, 0, 0], 1],
		['nonfinite color', [Number.NaN, 0.5, 0.2, 1], 1],
		['stale generation', oldColor, 2]
	]) {
		history.write(new Float32Array(colorRecord), HISTORY_CAPACITY * packing.HISTORY_SAMPLES * 16);
		history.write(new Float32Array([-1.6, 0, 0, generation]), 0);
		assert.deepEqual(
			await render({ bodies: false, trails: true }),
			await render({ bodies: false, trails: true, indexed: false }),
			`indexed ${name} preserves original validity/fallback behavior`
		);
	}
	console.log(
		'PASS indexed trail triangles exactly preserve history, live heads and invalid-record fallbacks'
	);
	const mixed = structuredClone(baseScene);
	mixed.species[0].population = 2;
	mixed.species[0].trail.length = 0.12;
	mixed.species.push({
		...structuredClone(mixed.species[0]),
		key: 'amber',
		name: 'Amber',
		population: 1,
		trail: { ...mixed.species[0].trail, length: 0.02 },
		visual: { ...structuredClone(mixed.species[0].visual), hsl: [0.1, 0.9, 0.6] }
	});
	const mixedAgents = model.initializePopulation(mixed).agents;
	const mixedHistory = new Float32Array(
		(HISTORY_CAPACITY * packing.HISTORY_SAMPLES * packing.HISTORY_SAMPLE_BYTES) / 4
	);
	mixedAgents.forEach((agent, index) => {
		agent.position = [-1 + index * 1.2, (index - 1) * 0.3, 0];
		agent.velocity = [1, 0, 0];
		for (let age = 0; age < 2; age++) {
			const slot = index * packing.HISTORY_SAMPLES + (1 - age);
			mixedHistory.set([agent.position[0] - 0.4 - age * 0.6, agent.position[1], 0, 1], slot * 4);
			mixedHistory.set(
				[0.3 + index * 0.2, 0.25 + age * 0.15, 0.5 - index * 0.1, 1],
				(HISTORY_CAPACITY * packing.HISTORY_SAMPLES + slot) * 4
			);
		}
	});
	config.write(
		packing.packConfig(mixed, {
			population: 3,
			historyCapacity: 3,
			tick: 120,
			historyHead: 1,
			validHistory: 2,
			historyElapsed: 0.05
		})
	);
	particles.write(packing.packParticles(mixedAgents, mixed, 1));
	metrics.write(new Float32Array((3 * packing.METRIC_BYTES) / 4));
	species.write(packing.packSpecies(mixed));
	history.write(mixedHistory);
	const mixedReference = await render({
		bodies: false,
		trails: true,
		indexed: false,
		instances: 3
	});
	const mixedRanges = trailRendering.trailSpeciesRanges(mixed).map((range) => ({
		...range,
		segments: trailRendering.trailSegmentCount(
			mixed.species.find((species) => species.key === range.key).trail.length,
			0.05,
			0.05,
			2
		)
	}));
	assert.deepEqual(
		mixedRanges.map((range) => [range.firstInstance, range.instances, range.segments]),
		[
			[0, 1, 1],
			[1, 2, 2]
		]
	);
	assert.deepEqual(
		await render({ bodies: false, trails: true, trailRanges: mixedRanges }),
		mixedReference,
		'per-species indexed draw ranges/firstInstance preserve full-population triangles exactly'
	);
	console.log(
		'PASS indexed per-species ranges preserve order, stable slots and independently shortened trails'
	);
	const surface = structuredClone(baseScene);
	surface.world = { kind: 'surface', shape: 'sphere', radius: 4 };
	configure(surface);
	const empty = await render({ bodies: false });
	const occluder = await render({ bodies: false, enclosure: true });
	assert.deepEqual(
		occluder,
		empty,
		'depth-only world shell leaves every background color component unchanged'
	);
	configure(surface, [0, 0, -4]);
	assert.deepEqual(
		await render({ enclosure: true }),
		empty,
		'far-side body is depth occluded without enclosure coloring'
	);
	configure(surface, [0, 0, 4]);
	const front = await render({ enclosure: true });
	assert.ok(
		front.some((value, i) => i % 4 === 3 && value > 0.5),
		'near-side body remains visible'
	);
	console.log(
		'PASS invisible depth-only surface shell preserves background and real near/far occlusion'
	);
	await gpu.gpu.queue.onSubmittedWorkDone();
	await gpu.settled();
	assert.deepEqual(errors, [], 'no native shader/render/readback errors');
	console.log('Native rendering/history gates passed. Inspection images: .cache/rendering/');
} finally {
	await gpu.gpu.queue.onSubmittedWorkDone();
	for (const buffer of owned) buffer.destroy();
	await gpu.dispose();
}
