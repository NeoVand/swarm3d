import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, compute, draw, frame, target } from 'vgpu/node';
import { perspectiveCamera } from 'vgpu/scene';

// Run with the interactive preview paused. The probe uses the exact production
// contour helper and full guide shader, rather than a test-only grid renderer.
const require = createRequire(import.meta.url),
	dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const { PNG } = await import(
	pathToFileURL(require.resolve('pngjs', { paths: [dependencyRoot] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, meshModel, chartModel, packing;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	meshModel = await vite.ssrLoadModule('/src/lib/model/topology-mesh.ts');
	chartModel = await vite.ssrLoadModule('/src/lib/model/topology-chart.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
} finally {
	await vite.close();
}
const source = (await resolveShader({ entry: resolve('src/lib/gpu/shaders/world.wgsl') })).wgsl;
const helper = source.match(/struct \w*GridSegment\s*\{[\s\S]*?(?=@vertex)/)?.[0],
	segmentFunction = source.match(/fn (\w*topology_grid_segment)\(/)?.[1];
const constants = source.match(/^\s*const \w*(?:PI|TAU)\s*[^\n]+$/gm)?.join('\n') ?? '';
assert.ok(helper && segmentFunction, 'production intrinsic grid helper is available');
const gpu = await init({ requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const owned = [];
const alloc = (label, bytes) => {
	const resource = gpu.device.createBuffer({
		label,
		size: Math.max(16, bytes),
		usage: ['storage', 'copy_dst', 'copy_src']
	});
	owned.push(resource);
	return resource;
};
const probe = compute(
	gpu,
	`${constants}\n${helper}
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&input)/6u){return;}
 let at=id.x*6u;
 let points=array<vec3f,3>(input[at].xyz,input[at+1u].xyz,input[at+2u].xyz);
 let chart=array<vec2f,3>(input[at+3u].xy,input[at+4u].xy,input[at+5u].xy);
 let segment=${segmentFunction}(points,chart,u32(input[at+3u].z),input[at+3u].w,input[at+5u].w>0.5);
 result[id.x*2u]=vec4f(segment.a,select(0.0,1.0,segment.valid));
 result[id.x*2u+1u]=vec4f(segment.b,select(0.0,1.0,segment.valid));
}`,
	{ entry: 'probe' }
);
const stage = target(gpu, { size: [512, 512], format: 'rgba8unorm', depth: true });
const camera = perspectiveCamera({
	fov: 42,
	aspect: 1,
	position: [8, 4, 45],
	target: [0, 0, 0],
	near: 0.05,
	far: 200
});
const cameraBlock = () => ({
	viewProjection: camera.viewProjection,
	position: [...camera.worldPosition, 1],
	right: [1, 0, 0, 1],
	up: [0, 1, 0, 512]
});
await mkdir('.cache/surface-grid', { recursive: true });
const report = [];
try {
	for (const shape of ['mobius', 'klein', 'projective', 'trefoil']) {
		const world = { kind: 'surface', shape, radius: 14 },
			mesh = meshModel.createTopologyMesh(shape, world.radius),
			counts = chartModel.topologyGridCounts(shape),
			fixtures = [];
		for (let face = 0; face < mesh.triangles.length; face++) {
			const points = mesh.triangles[face].map((vertex) => mesh.vertices[vertex]),
				chart = mesh.charts[face];
			if (shape === 'projective') {
				for (let slot = 0; slot < 6; slot++) {
					const fixture = chartModel.projectiveGridFixture(chart, slot);
					fixtures.push({
						points,
						...fixture,
						family: 0,
						includeMinimum: true,
						expected: chartModel.topologyGridSegment(points, fixture.chart, 0, fixture.level, true)
					});
				}
				continue;
			}
			for (let family = 0; family < 2; family++) {
				const low = Math.min(...chart.map((point) => point[family]));
				for (let ordinal = 0; ordinal < 3; ordinal++) {
					const level = (Math.floor((low + 1e-7) * counts[family]) + 1 + ordinal) / counts[family];
					fixtures.push({
						points,
						chart,
						family,
						level,
						expected: chartModel.topologyGridSegment(points, chart, family, level)
					});
				}
			}
		}
		const inputs = new Float32Array(fixtures.length * 24),
			output = alloc(`${shape} extracted grid segments`, fixtures.length * 32),
			input = alloc(`${shape} grid chart fixtures`, inputs.byteLength);
		fixtures.forEach((fixture, index) => {
			const at = index * 24;
			fixture.points.forEach((point, corner) => inputs.set(point, at + corner * 4));
			fixture.chart.forEach((point, corner) => inputs.set(point, at + 12 + corner * 4));
			inputs[at + 14] = fixture.family;
			inputs[at + 15] = fixture.level;
			inputs[at + 23] = Number(fixture.includeMinimum ?? false);
		});
		input.write(inputs);
		probe.set({ input, result: output }).dispatch(Math.ceil(fixtures.length / 64));
		const segments = new Float32Array(await output.read(fixtures.length * 32));
		let maximumError = 0,
			valid = 0;
		fixtures.forEach((fixture, index) => {
			const at = index * 8;
			assert.equal(
				segments[at + 3],
				Number(Boolean(fixture.expected)),
				`${shape} face guide ${index} validity`
			);
			if (!fixture.expected) return;
			valid++;
			fixture.expected.forEach((point, endpoint) =>
				point.forEach((value, axis) => {
					maximumError = Math.max(
						maximumError,
						Math.abs(segments[at + endpoint * 4 + axis] - value)
					);
				})
			);
		});
		assert.ok(
			maximumError < 1e-5,
			`${shape} actual-face contour endpoints agree with CPU to ${maximumError}`
		);
		assert.ok(valid > 20, `${shape} has meaningful chart families`);
		const scene = model.createDefaultScene();
		scene.world = world;
		scene.visual.showBoundary = false;
		scene.visual.showGrid = true;
		const values = packing.packConfig(scene, {
				population: 0,
				tick: 0,
				historyHead: 0,
				validHistory: 1
			}),
			config = alloc(`${shape} physical guide atlas`, values.byteLength);
		config.write(values);
		const shell = draw(gpu, {
				shader: source,
				entry: { vertex: 'vs_shell', fragment: 'fs_shell' },
				vertices: mesh.triangles.length * 3,
				writeMask: [],
				depth: { write: true },
				set: { config, camera: cameraBlock() }
			}),
			grid = draw(gpu, {
				shader: source,
				vertices: mesh.triangles.length * 54,
				blend: 'alpha',
				depth: { write: false },
				set: { config, camera: cameraBlock() }
			});
		const render = async (phase = 0) => {
			const offset = (phase * 45 * 2 * Math.tan((21 * Math.PI) / 180)) / 512;
			camera.set({ position: [8 + offset, 4, 45] });
			camera.lookAt([offset, 0, 0]);
			shell.set({ camera: cameraBlock() });
			grid.set({ camera: cameraBlock() });
			frame(gpu, (f) =>
				f.pass({ target: stage, clear: [0, 0, 0, 1], clearDepth: 1 }, (p) => {
					p.draw(shell);
					p.draw(grid);
				})
			);
			return stage.color.read({ mipLevel: 0, region: 'all' });
		};
		const pixels = await render(),
			energy = [];
		let colored = 0;
		for (let i = 0; i < pixels.length; i += 4)
			if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 3) colored++;
		assert.ok(
			colored > 50 && colored < 512 * 512 * 0.15,
			`${shape} grid remains sparse, observed ${colored} pixels`
		);
		for (let phase = 0; phase < 8; phase++)
			energy.push(
				(await render(phase / 8)).reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0)
			);
		const variation =
			(Math.max(...energy) - Math.min(...energy)) /
			(energy.reduce((a, b) => a + b, 0) / energy.length);
		assert.ok(variation < 0.07, `${shape} subpixel radiance variation ${variation}`);
		const png = new PNG({ width: 512, height: 512 });
		png.data.set(pixels);
		await writeFile(`.cache/surface-grid/${shape}.png`, PNG.sync.write(png));
		report.push({
			shape,
			fixtures: fixtures.length,
			valid,
			maximumError,
			colored,
			subpixelRadianceVariation: variation
		});
		console.log(
			`PASS ${shape}: ${valid} intrinsic segments, max GPU error ${maximumError}, ${(variation * 100).toFixed(2)}% subpixel radiance variation`
		);
	}
	await gpu.settled();
	assert.deepEqual(errors, []);
	await writeFile('.cache/surface-grid/verification.json', JSON.stringify(report, null, 2));
} finally {
	await gpu.gpu.queue.onSubmittedWorkDone();
	owned.forEach((resource) => resource.destroy());
	gpu.dispose();
}
