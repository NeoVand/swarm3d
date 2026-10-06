import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init } from 'vgpu/node';

// Run baseline and candidate separately, with the interactive swarm paused:
// node scripts/surface-continuity-performance.mjs --source .cache/continuity-baseline --label baseline
// node scripts/surface-continuity-performance.mjs --label candidate
// The baseline saves immutable seeded face/barycentric fixtures. The candidate
// reuses those native locations on its smooth field; accepted counts are reported
// because fixing false exclusions intentionally changes the physical answer.
const option = (name, fallback) => process.argv[process.argv.indexOf(name) + 1] ?? fallback;
const source = resolve(process.argv.includes('--source') ? option('--source') : '.');
const label = process.argv.includes('--label') ? option('--label') : 'candidate';
const require = createRequire(import.meta.url);
const { resolveShader } = await import(
	pathToFileURL(
		require.resolve('@vgpu/wgsl/runtime', { paths: [dirname(require.resolve('vgpu'))] })
	).href
);
const vite = await createServer({
	configFile: false,
	root: source,
	resolve: { alias: { '#lib': resolve(source, 'src/lib') } },
	server: { middlewareMode: true },
	appType: 'custom'
});
let model, packing;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
} finally {
	await vite.close();
}
const shaders = {};
for (const name of ['grid', 'simulate', 'metrics'])
	shaders[name] = (
		await resolveShader({ entry: resolve(source, `src/lib/gpu/shaders/${name}.wgsl`) })
	).wgsl;
const gpu = await init({
	requiredFeatures: ['timestamp-query'],
	requiredLimits: { maxStorageBuffersPerShaderStage: 8 }
});
const device = gpu.gpu,
	errors = [];
gpu.onError((error) => errors.push(String(error)));
device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const layout = (types) =>
	device.createBindGroupLayout({
		entries: types.map((type, binding) => ({ binding, visibility: 4, buffer: { type } }))
	});
const read = 'read-only-storage',
	storage = 'storage';
const layouts = {
	grid: layout([read, read, storage, storage, storage]),
	simulate: layout([read, read, storage, read, read, read, read, read]),
	metrics: layout([read, read, read, storage, read, read, read])
};
async function pipeline(name, entryPoint, constants) {
	const module = device.createShaderModule({ code: shaders[name] });
	assert.deepEqual(
		(await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'),
		[]
	);
	return device.createComputePipelineAsync({
		layout: device.createPipelineLayout({ bindGroupLayouts: [layouts[name]] }),
		compute: { module, entryPoint, constants }
	});
}
const gridEntries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const pipelines = {
	grid: await Promise.all(gridEntries.map((entry) => pipeline('grid', entry))),
	simulate: await pipeline('simulate', 'simulate', { 0: 99 }),
	metrics: await pipeline('metrics', 'measure', { 0: 0, 1: 1 })
};
const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
const queryResolve = device.createBuffer({ size: 256, usage: 512 | 4 });
const queryRead = device.createBuffer({ size: 16, usage: 1 | 8 });
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const repeats = 4;
async function submit(operation, timed = false) {
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginComputePass(
		timed
			? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
			: {}
	);
	operation(pass);
	pass.end();
	if (timed) {
		encoder.resolveQuerySet(querySet, 0, 2, queryResolve, 0);
		encoder.copyBufferToBuffer(queryResolve, 0, queryRead, 0, 16);
	}
	device.queue.submit([encoder.finish()]);
	await device.queue.onSubmittedWorkDone();
	if (!timed) return;
	await queryRead.mapAsync(1);
	const stamps = new BigUint64Array(queryRead.getMappedRange());
	const ms = Number(stamps[1] - stamps[0]) / 1e6 / repeats;
	queryRead.unmap();
	return ms;
}
function dispatch(pass, pipeline, bindings, count) {
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bindings);
	pass.dispatchWorkgroups(count);
}
await mkdir('.cache/continuity-fixtures', { recursive: true });
const report = {
	recordedAt: new Date().toISOString(),
	label,
	adapter: device.adapterInfo,
	method:
		'Settled GPU pass timestamps, median of seven four-dispatch samples after three warmups; immutable native locations and coherent measured neighbors. Excludes rendering and browser FPS. Clustered fixtures group 128 agents per small face patch. Complete accepted neighborhood counts accompany timings.',
	cases: []
};
try {
	for (const shape of ['trefoil', 'klein', 'mobius']) {
		for (const [count, distribution] of [
			[5000, 'ordinary'],
			[10000, 'ordinary'],
			[20000, 'ordinary'],
			[7700, 'clustered']
		]) {
			const scene = model.resizePopulation(model.createDefaultScene(), count);
			scene.world = {
				kind: 'surface',
				shape,
				radius: 17.5,
				...(shape === 'trefoil' ? { tubeRadius: 2.16 } : {})
			};
			scene.seed = 73419;
			scene.species.forEach((s) => {
				s.perception = 0.935;
				s.cruiseSpeed = 0.8;
				s.speed = 3.7;
				s.separation = 3.8;
			});
			scene.forces.enabled = false;
			const fixturePath = `.cache/continuity-fixtures/${shape}-${count}-${distribution}.json`;
			let agents;
			if (label === 'baseline') {
				agents = model.initializePopulation(scene).agents;
				if (distribution === 'clustered') {
					const mesh = model.topologyMesh(scene.world);
					for (let i = 0; i < count; i++) {
						const anchor = agents[Math.floor(i / 128) * 128];
						agents[i].triangle = anchor.triangle;
						agents[i].orientation = anchor.orientation;
						agents[i].position = [...anchor.position];
						agents[i].velocity = model.tangentProjection(
							agents[i].velocity,
							mesh.normals[anchor.triangle]
						);
					}
				}
				await writeFile(fixturePath, JSON.stringify(agents));
			} else agents = JSON.parse(await readFile(fixturePath, 'utf8'));
			const fixtureHash = createHash('sha256').update(JSON.stringify(agents)).digest('hex');
			const grid = packing.gridDefinition(scene),
				packedConfig = packing.packConfig(scene, {
					population: count,
					tick: 77,
					historyHead: 0,
					validHistory: 1,
					metricMask: 31,
					smoothingAlpha: 1
				});
			const owned = [];
			const alloc = (name, size) => {
				const b = gpu.device.createBuffer({
					label: name,
					size: Math.max(16, size),
					usage: ['storage', 'copy_src', 'copy_dst']
				});
				owned.push(b);
				return b;
			};
			const b = {
				config: alloc('config', packedConfig.byteLength),
				state: alloc('immutable particles', count * 64),
				next: alloc('output', count * 64),
				prior: alloc('prior metrics', count * 64),
				measured: alloc('measurements', count * 64),
				grid: alloc('CSR grid', grid.count * 12 + 4),
				indices: alloc('all indices', count * 4),
				blocks: alloc('prefix blocks', Math.ceil(grid.count / 256) * 4),
				species: alloc('species', scene.species.length * 1024),
				pairs: alloc('rules', scene.species.length ** 2 * 16)
			};
			const group = (layout, buffers) =>
				device.createBindGroup({
					layout,
					entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
				});
			const groups = {
				grid: group(layouts.grid, [b.config, b.state, b.grid, b.indices, b.blocks]),
				simulate: group(layouts.simulate, [
					b.config,
					b.state,
					b.next,
					b.grid,
					b.indices,
					b.prior,
					b.species,
					b.pairs
				]),
				metrics: group(layouts.metrics, [
					b.config,
					b.state,
					b.prior,
					b.measured,
					b.grid,
					b.indices,
					b.species
				])
			};
			try {
				b.state.write(packing.packParticles(agents, scene, 1));
				b.config.write(packedConfig);
				b.species.write(packing.packSpecies(scene));
				b.pairs.write(packing.packPairRules(scene));
				const cells = Math.ceil(grid.count / 256),
					groupsCount = Math.ceil(count / 128);
				const counts = [cells, Math.ceil(count / 256), cells, 1, cells, Math.ceil(count / 256)];
				await submit((pass) => {
					pipelines.grid.forEach((p, i) => {
						if (cells === 1 && (i === 3 || i === 4)) return;
						dispatch(pass, p, groups.grid, counts[i]);
					});
					dispatch(pass, pipelines.metrics, groups.metrics, groupsCount);
				});
				const measurements = new Float32Array(await b.measured.read(count * 64));
				b.prior.write(measurements);
				const neighbors = Array.from({ length: count }, (_, i) => measurements[i * 16 + 3]);
				const item = {
					shape,
					count,
					distribution,
					fixtureHash,
					atlasBytes: packedConfig.byteLength,
					meanNeighbors: neighbors.reduce((sum, n) => sum + n, 0) / count,
					maximumNeighbors: Math.max(...neighbors)
				};
				for (const kind of ['simulate', 'metrics']) {
					const operation = (pass) => {
						for (let i = 0; i < repeats; i++)
							dispatch(pass, pipelines[kind], groups[kind], groupsCount);
					};
					for (let warm = 0; warm < 3; warm++) await submit(operation);
					const samples = [];
					for (let sample = 0; sample < 7; sample++) samples.push(await submit(operation, true));
					item[`${kind}MedianMs`] = median(samples);
				}
				const result = new Float32Array(await b.next.read(count * 64));
				for (let i = 0; i < count; i++)
					for (let word = 0; word < 12; word++)
						assert.ok(Number.isFinite(result[i * 16 + word]), 'Finite simulated fields');
				report.cases.push(item);
				console.log(JSON.stringify(item));
				await writeFile(
					`.cache/surface-continuity-${label}.json`,
					JSON.stringify(report, null, 2) + '\n'
				);
			} finally {
				await device.queue.onSubmittedWorkDone();
				owned.forEach((b) => b.destroy());
			}
		}
	}
	await gpu.settled();
	assert.deepEqual(errors, [], 'No device errors');
} finally {
	await device.queue.onSubmittedWorkDone();
	querySet.destroy();
	queryResolve.destroy();
	queryRead.destroy();
	await gpu.dispose();
}
