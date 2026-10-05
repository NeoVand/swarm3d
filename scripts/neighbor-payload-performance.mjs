import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init } from 'vgpu/node';

// Diagnostic only. Acquire the GPU only in an exclusive benchmark lane.
// Freeze source once; --refresh explicitly starts a new baseline comparison.
// A candidate record replaces the index buffer, so binding counts stay unchanged.
const require = createRequire(import.meta.url);
const dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const folder = '.cache/neighbor-payload-sources';
await mkdir(folder, { recursive: true });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const variants = ['baseline', 'candidate'];
const kernelNames = ['grid', 'simulate', 'metrics'];
const manifestFile = `${folder}/manifest.json`;
const recordDefinition = `
struct NeighborRecord {
  position: vec3f,
  slotSpecies: u32,
  velocity: vec3f,
  stableId: u32,
}
`;
function replace(source, before, after) {
	assert.equal(source.split(before).length - 1, 1, `Unique diagnostic anchor: ${before}`);
	return source.replace(before, after);
}
let manifest;
try {
	if (process.argv.includes('--refresh')) throw new Error('Explicit refresh');
	manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
} catch (error) {
	if (error.code !== 'ENOENT' && !process.argv.includes('--refresh')) throw error;
	const raw = Object.fromEntries(
		await Promise.all(
			['common', ...kernelNames].map(async (name) => [
				name,
				await readFile(`src/lib/gpu/shaders/${name}.wgsl`, 'utf8')
			])
		)
	);
	const candidates = {};
	for (const name of kernelNames) {
		let source = replace(
			raw[name],
			'var<storage, read' + (name === 'grid' ? '_write' : '') + '> indices: array<u32>;',
			'var<storage, read' + (name === 'grid' ? '_write' : '') + '> indices: array<NeighborRecord>;'
		);
		source =
			source.slice(0, source.indexOf('\n') + 1) +
			recordDefinition +
			source.slice(source.indexOf('\n') + 1);
		if (name === 'grid') {
			source = replace(
				source,
				'  indices[atomicLoad(&grid[cells + cell]) + slot] = id.x;',
				`  let p=particles[id.x];
  indices[atomicLoad(&grid[cells + cell]) + slot] = NeighborRecord(p.position.xyz,id.x|(p.identity.y<<24u),p.velocity.xyz,p.identity.x);`
			);
		} else {
			const stateName = name === 'simulate' ? 'current' : 'particles';
			const sourceSlot = name === 'simulate' ? 'neighborSlot' : 'offset+j';
			source = replace(
				source,
				`          let neighborIndex=indices[${sourceSlot}];
          if (neighborIndex==index) { continue; }
          let neighbor=${stateName}[neighborIndex];`,
				`          let record=indices[${sourceSlot}];
          let neighborIndex=record.slotSpecies&0xffffffu;
          if (neighborIndex==index) { continue; }
          // Only these hot fields are consumed by either neighbor loop.
          let neighbor=Particle(vec4f(record.position,0.0),vec4f(record.velocity,0.0),vec4f(0.0),vec4u(record.stableId,record.slotSpecies>>24u,1u,0u));`
			);
			if (name === 'simulate')
				source = replace(
					source,
					'index=indices[invocation.x];',
					'index=indices[invocation.x].slotSpecies&0xffffffu;'
				);
			const consumed = [...raw[name].matchAll(/neighbor\.([A-Za-z]+)\.([xyzw]+)/g)].map(
				(m) => `${m[1]}.${m[2]}`
			);
			assert.ok(
				consumed.every((field) =>
					['position.xyz', 'velocity.xyz', 'identity.x', 'identity.y'].includes(field)
				),
				`All ${name} hot neighbor fields represented: ${consumed}`
			);
		}
		candidates[name] = source;
	}
	await writeFile(`${folder}/common.wgsl`, raw.common);
	for (const name of kernelNames) {
		await writeFile(`${folder}/baseline-${name}.wgsl`, raw[name]);
		await writeFile(`${folder}/candidate-${name}.wgsl`, candidates[name]);
	}
	manifest = {
		recordedAt: new Date().toISOString(),
		sourceHashes: Object.fromEntries(
			Object.entries(raw).map(([name, source]) => [name, sha256(source)])
		),
		candidateHashes: Object.fromEntries(
			Object.entries(candidates).map(([name, source]) => [name, sha256(source)])
		)
	};
	await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
const shaders = {};
for (const name of kernelNames) {
	shaders[name] = {};
	for (const variant of variants)
		shaders[name][variant] = (
			await resolveShader({ entry: resolve(`${folder}/${variant}-${name}.wgsl`), validate: false })
		).wgsl;
}
if (process.argv.includes('--prepare-only')) {
	console.log(JSON.stringify({ prepared: true, ...manifest }, null, 2));
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
	requiredLimits: { maxStorageBuffersPerShaderStage: 8 }
});
const device = gpu.gpu;
const errors = [];
gpu.onError((error) => errors.push(String(error)));
device.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const layouts = {
	grid: device.createBindGroupLayout({
		entries: Array.from({ length: 5 }, (_, binding) => ({
			binding,
			visibility: 4,
			buffer: { type: binding < 2 ? 'read-only-storage' : 'storage' }
		}))
	}),
	simulate: device.createBindGroupLayout({
		entries: Array.from({ length: 8 }, (_, binding) => ({
			binding,
			visibility: 4,
			buffer: { type: binding === 2 ? 'storage' : 'read-only-storage' }
		}))
	}),
	metrics: device.createBindGroupLayout({
		entries: Array.from({ length: 7 }, (_, binding) => ({
			binding,
			visibility: 4,
			buffer: { type: binding === 3 ? 'storage' : 'read-only-storage' }
		}))
	})
};
const gridEntries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const pipelines = {};
async function pipeline(code, layout, entryPoint, constants) {
	const module = device.createShaderModule({ code });
	assert.deepEqual(
		(await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'),
		[],
		`${entryPoint} compiles`
	);
	return device.createComputePipelineAsync({
		layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
		compute: { module, entryPoint, constants }
	});
}
for (const variant of variants) {
	pipelines[variant] = {
		grid: await Promise.all(
			gridEntries.map((entryPoint) => pipeline(shaders.grid[variant], layouts.grid, entryPoint))
		),
		simulate: await pipeline(shaders.simulate[variant], layouts.simulate, 'simulate'),
		metrics: {
			generic: await pipeline(shaders.metrics[variant], layouts.metrics, 'measure', { 0: 0, 1: 0 }),
			complete: await pipeline(shaders.metrics[variant], layouts.metrics, 'measure', {
				0: 1,
				1: 0
			}),
			unit: await pipeline(shaders.metrics[variant], layouts.metrics, 'measure', { 0: 0, 1: 1 })
		}
	};
}
const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
const queryResolve = device.createBuffer({ size: 256, usage: 512 | 4 });
const queryRead = device.createBuffer({ size: 16, usage: 1 | 8 });
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const resultFile = '.cache/neighbor-payload-performance.json';
const results = {
	recordedAt: new Date().toISOString(),
	baseline: manifest,
	vgpu: '0.5.0',
	adapter: device.adapterInfo,
	method: {
		work: 'One immutable-state simulation tick, one complete resulting-state index build, then measurement of that resulting state. The initial completed index is inherited outside timestamps, as in production. Frozen-order kernel controls use the same complete cell index for exact parity; timed scatter order may vary.',
		layout:
			'32-byte contiguous position/slot-species/velocity/stable-ID hot record replaces 4-byte original-slot index. Stable 64-byte particle/output/history state remains in original slots. No additional storage binding.',
		timing:
			'Standard compute-pass GPU timestamps; actual queue settlement after each sample. Excludes history and rendering.',
		pairedSamples: 10,
		warmupsPerVariant: 3,
		masks: [7, 23, 87, 32767],
		gate: 'Frozen-order simulation and requested metrics bitwise identical. Complete membership, cell counts, stable slot/species/ID and hot field bytes checked after GPU scatter.'
	},
	controls: [],
	cases: []
};
const worldDefinitions = {
	box: { kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' },
	sphere: { kind: 'surface', shape: 'sphere', radius: 16 },
	plane: { kind: 'surface', shape: 'plane', halfExtents: [18, 18], boundaries: 'reflect' },
	cylinder: { kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 14 },
	torus: { kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 }
};
function makeScene(count, domain, profile) {
	const scene = model.resizePopulation(model.createDefaultScene(), count);
	scene.seed = 0xc37ae19b;
	scene.world = structuredClone(worldDefinitions[domain]);
	if (domain === 'torus') {
		for (const species of scene.species) species.perception = 2;
		scene.forces.radius = 2;
	}
	const [a, b] = scene.species;
	const pair = (from, to, behavior, strength = 0.6) => ({
		id: `${from}-${to === '*' ? 'all' : to}-${behavior}`,
		from,
		to,
		behavior,
		strength,
		radius: null
	});
	const rule = (role, behavior) => ({
		id: `${role}-${behavior}`,
		metric: 'speed',
		role,
		behavior,
		strength: 0.5,
		radius: null,
		range: [0, a.speed],
		curve: model.curvePreset('linear')
	});
	if (profile.startsWith('behavior-')) {
		const behavior = profile.slice(9);
		scene.speciesRules = [pair(a.key, b.key, behavior), pair(b.key, a.key, behavior, 0.4)];
	} else if (profile.startsWith('metric-')) {
		a.metricRules = [rule(profile.slice(7), 'chase')];
		b.metricRules = [rule(profile.slice(7), 'mirror')];
	} else if (profile === 'fallback') {
		scene.speciesRules = [
			pair(a.key, '*', 'chase'),
			pair(a.key, b.key, 'ignore'),
			pair(b.key, '*', 'flee'),
			pair(b.key, a.key, 'chase', 0)
		];
	} else if (profile === 'coincident') {
		scene.speciesRules = [pair(a.key, b.key, 'disperse'), pair(b.key, a.key, 'mob')];
	}
	model.assertScene(scene);
	assert.ok(
		count < 0x1000000 && scene.species.length <= 256,
		'24-bit original slots / 8-bit species packing bounds'
	);
	return scene;
}
function densePosition(agent, domain) {
	if (domain === 'box' || domain === 'plane') return agent.position.map((v) => v * 0.015);
	if (domain === 'sphere') {
		const cap = [agent.position[0] * 0.01, agent.position[1] * 0.01, 16];
		const scale = 16 / Math.hypot(...cap);
		return cap.map((v) => v * scale);
	}
	if (domain === 'cylinder') {
		const angle = Math.atan2(agent.position[2], agent.position[0]) * 0.015;
		return [12 * Math.cos(angle), agent.position[1] * 0.015, 12 * Math.sin(angle)];
	}
	if (domain === 'torus') {
		const theta =
			Math.atan2(agent.position[1], Math.hypot(agent.position[0], agent.position[2]) - 20) * 0.015;
		const phi = Math.atan2(agent.position[2], agent.position[0]) * 0.015;
		const radial = 20 + 8 * Math.cos(theta);
		return [radial * Math.cos(phi), 8 * Math.sin(theta), radial * Math.sin(phi)];
	}
	return agent.position;
}
function gatherCPU(indices, particleBytes) {
	const slots = new Uint32Array(indices);
	const source = new Uint32Array(particleBytes);
	const output = new Uint32Array(slots.length * 8);
	for (let j = 0; j < slots.length; j++) {
		const slot = slots[j],
			offset = slot * 16;
		output.set(source.subarray(offset, offset + 3), j * 8);
		output[j * 8 + 3] = slot | (source[offset + 13] << 24);
		output.set(source.subarray(offset + 4, offset + 7), j * 8 + 4);
		output[j * 8 + 7] = source[offset + 12];
	}
	return output;
}
function equalWords(a, b, label) {
	assert.deepEqual(new Uint32Array(b), new Uint32Array(a), `${label}: bitwise identical`);
}
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
	if (!timed) return null;
	await queryRead.mapAsync(1);
	const stamps = new BigUint64Array(queryRead.getMappedRange());
	const value = Number(stamps[1] - stamps[0]) / 1e6;
	queryRead.unmap();
	assert.ok(value > 0 && Number.isFinite(value), 'Valid settled GPU interval');
	return value;
}
function dispatch(pass, pipeline, group, workgroups) {
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, group);
	pass.dispatchWorkgroups(workgroups);
}
function metricVariant(mask) {
	return mask === 32767 ? 'complete' : mask & 64 && !(mask & ~351) ? 'unit' : 'generic';
}
async function runCase(
	count,
	domain,
	distribution = 'ordinary',
	profile = 'default',
	timed = false
) {
	const scene = makeScene(count, domain, profile);
	const agents = model.initializePopulation(scene).agents;
	if (distribution === 'dense')
		for (const agent of agents) {
			agent.position = densePosition(agent, domain);
			if (domain === 'sphere')
				agent.velocity = model.tangentProjection(agent.velocity, agent.position);
			else if (domain === 'cylinder')
				agent.velocity = model.tangentProjection(agent.velocity, [
					agent.position[0],
					0,
					agent.position[2]
				]);
			else if (domain === 'torus') {
				const radial = Math.hypot(agent.position[0], agent.position[2]);
				agent.velocity = model.tangentProjection(agent.velocity, [
					agent.position[0] * (1 - 20 / radial),
					agent.position[1],
					agent.position[2] * (1 - 20 / radial)
				]);
			}
		}
	if (profile === 'coincident') {
		for (const i of [1, scene.species[0].population]) {
			agents[i].position = [...agents[0].position];
			if (domain !== 'box') agents[i].velocity = [...agents[0].velocity];
		}
		agents[0].velocity = [0, 0, 0];
	}
	const particleBytes = packing.packParticles(agents, scene, 1);
	const particleWords = new Uint32Array(particleBytes);
	if (profile === 'inactive')
		for (const slot of [0, scene.species[0].population, count - 1])
			particleWords[slot * 16 + 14] = 0;
	if (profile === 'uint-identities')
		for (let slot = 0; slot < count; slot++) particleWords[slot * 16 + 12] = 0x7fc00000 + slot;
	const activeCount = agents.reduce((sum, _, i) => sum + (particleWords[i * 16 + 14] ? 1 : 0), 0);
	const definition = packing.gridDefinition(scene);
	const owned = [];
	const alloc = (label, size) => {
		const buffer = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(buffer);
		return buffer;
	};
	const shared = {
		config: alloc('config', 16384),
		current: alloc('frozen current', count * 64),
		prior: alloc('frozen prior metrics', count * 64),
		species: alloc('species', scene.species.length * 1024),
		pairs: alloc('pair rules', scene.species.length ** 2 * 16)
	};
	const buffers = Object.fromEntries(
		variants.map((variant) => [
			variant,
			{
				next: alloc(`${variant} next`, count * 64),
				measured: alloc(`${variant} measured`, count * 64),
				grid: alloc(`${variant} grid`, definition.count * 12 + 4),
				gridNext: alloc(`${variant} resulting grid`, definition.count * 12 + 4),
				indices: alloc(`${variant} indices`, count * (variant === 'baseline' ? 4 : 32)),
				indicesNext: alloc(
					`${variant} resulting indices`,
					count * (variant === 'baseline' ? 4 : 32)
				),
				blocks: alloc(`${variant} blocks`, Math.ceil(definition.count / 256) * 4)
			}
		])
	);
	const group = (layout, values) =>
		device.createBindGroup({
			layout,
			entries: values.map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
		});
	const bindings = Object.fromEntries(
		variants.map((variant) => {
			const b = buffers[variant];
			return [
				variant,
				{
					index: [shared.current, b.next].map((state, side) =>
						group(layouts.grid, [
							shared.config,
							state,
							side === 0 ? b.grid : b.gridNext,
							side === 0 ? b.indices : b.indicesNext,
							b.blocks
						])
					),
					simulate: group(layouts.simulate, [
						shared.config,
						shared.current,
						b.next,
						b.grid,
						b.indices,
						shared.prior,
						shared.species,
						shared.pairs
					]),
					metrics: [shared.current, b.next].map((state, side) =>
						group(layouts.metrics, [
							shared.config,
							state,
							shared.prior,
							b.measured,
							side === 0 ? b.grid : b.gridNext,
							side === 0 ? b.indices : b.indicesNext,
							shared.species
						])
					)
				}
			];
		})
	);
	const cellGroups = Math.ceil(definition.count / 256);
	const indexDispatches = [
		cellGroups,
		Math.ceil(count / 256),
		cellGroups,
		1,
		cellGroups,
		Math.ceil(count / 256)
	];
	const agentGroups = Math.ceil(count / 128);
	function index(pass, variant, side = 0) {
		gridEntries.forEach((_, i) => {
			if (cellGroups === 1 && (i === 3 || i === 4)) return;
			dispatch(pass, pipelines[variant].grid[i], bindings[variant].index[side], indexDispatches[i]);
		});
	}
	function writeConfig(mask) {
		shared.config.write(
			packing.packConfig(scene, {
				population: count,
				tick: 77,
				simulationTime: 77 * scene.dynamics.fixedDt,
				historyHead: 0,
				validHistory: 1,
				smoothingAlpha: 0.13,
				sampleHistory: false,
				metricMask: mask
			})
		);
	}
	const result = {
		count,
		domain,
		distribution,
		profile,
		activeCount,
		inputSha256: sha256(new Uint8Array(particleBytes)),
		masks: {}
	};
	try {
		shared.current.write(particleBytes);
		shared.species.write(packing.packSpecies(scene));
		shared.pairs.write(packing.packPairRules(scene));
		writeConfig(32767);
		await submit((pass) => {
			index(pass, 'baseline');
			dispatch(
				pass,
				pipelines.baseline.metrics.complete,
				bindings.baseline.metrics[0],
				agentGroups
			);
		});
		shared.prior.write(await buffers.baseline.measured.read(count * 64));
		// Freeze both kernels to the exact baseline scatter order. Independently
		// scattered lists are allowed different floating summation order.
		const frozenGrid = await buffers.baseline.grid.read(definition.count * 12 + 4);
		const frozenIndices = await buffers.baseline.indices.read(activeCount * 4);
		buffers.candidate.grid.write(frozenGrid);
		buffers.candidate.indices.write(gatherCPU(frozenIndices, particleBytes));
		assert.equal(
			new Set(new Uint32Array(frozenIndices)).size,
			activeCount,
			'Complete baseline active membership'
		);
		for (const mask of [7, 23, 87, 32767]) {
			writeConfig(mask);
			for (const variant of variants)
				await submit((pass) => {
					dispatch(pass, pipelines[variant].simulate, bindings[variant].simulate, agentGroups);
					dispatch(
						pass,
						pipelines[variant].metrics[metricVariant(mask)],
						bindings[variant].metrics[0],
						agentGroups
					);
				});
			equalWords(
				await buffers.baseline.next.read(count * 64),
				await buffers.candidate.next.read(count * 64),
				`${domain}/${profile} particles mask ${mask}`
			);
			equalWords(
				await buffers.baseline.measured.read(count * 64),
				await buffers.candidate.measured.read(count * 64),
				`${domain}/${profile} metrics mask ${mask}`
			);
			result.masks[mask] = { bitwiseIdentical: true };
		}
		// Independently run the candidate's actual scatter and verify all packed
		// record bytes, original slots, IDs, species, complete cells and membership.
		await submit((pass) => index(pass, 'candidate'));
		equalWords(
			frozenGrid,
			await buffers.candidate.grid.read(definition.count * 12 + 4),
			'Candidate complete grid'
		);
		const hotWords = new Uint32Array(await buffers.candidate.indices.read(activeCount * 32));
		const hotSlots = Uint32Array.from(
			{ length: activeCount },
			(_, i) => hotWords[i * 8 + 3] & 0xffffff
		);
		assert.equal(new Set(hotSlots).size, activeCount, 'Every active slot scattered once');
		assert.deepEqual(
			[...hotSlots].sort((a, b) => a - b),
			[...new Uint32Array(frozenIndices)].sort((a, b) => a - b),
			'No active neighbor omitted'
		);
		equalWords(
			gatherCPU(hotSlots.buffer, particleBytes).buffer,
			hotWords.buffer,
			'Scatter hot fields retain exact u32/float bits'
		);
		result.membershipExact = true;
		result.maximumCellPopulation = Math.max(...new Uint32Array(frozenGrid, 0, definition.count));
		// The independent scatter above is a membership/layout gate. Restore the
		// original frozen permutation for identical simulation summation order.
		buffers.candidate.indices.write(gatherCPU(frozenIndices, particleBytes));
		if (timed)
			for (const mask of [7, 23, 87, 32767]) {
				writeConfig(mask);
				const tick = (pass, variant) => {
					dispatch(pass, pipelines[variant].simulate, bindings[variant].simulate, agentGroups);
					index(pass, variant, 1);
					dispatch(
						pass,
						pipelines[variant].metrics[metricVariant(mask)],
						bindings[variant].metrics[1],
						agentGroups
					);
				};
				for (let warm = 0; warm < results.method.warmupsPerVariant; warm++)
					for (const variant of variants) await submit((pass) => tick(pass, variant));
				const samples = { baseline: [], candidate: [] };
				for (let pair = 0; pair < results.method.pairedSamples; pair++)
					for (const variant of pair % 2 ? [...variants].reverse() : variants)
						samples[variant].push(await submit((pass) => tick(pass, variant), true));
				const baselineMs = median(samples.baseline),
					candidateMs = median(samples.candidate);
				result.masks[mask] = {
					...result.masks[mask],
					baselineMedianMs: baselineMs,
					candidateMedianMs: candidateMs,
					reductionFraction: 1 - candidateMs / baselineMs,
					samples
				};
				console.log(
					`${domain} ${distribution} ${count} mask ${mask}: ${baselineMs.toFixed(3)} → ${candidateMs.toFixed(3)} ms (${(100 * (1 - candidateMs / baselineMs)).toFixed(1)}%)`
				);
			}
		(timed ? results.cases : results.controls).push(result);
		await writeFile(resultFile, `${JSON.stringify(results, null, 2)}\n`);
		if (!timed)
			console.log(
				`CONTROL ${domain} ${profile}: all four masks bitwise equal; complete 32-byte scatter`
			);
	} finally {
		await device.queue.onSubmittedWorkDone();
		for (const buffer of owned) buffer.destroy();
	}
}
try {
	if (!process.argv.includes('--timings-only'))
		for (const domain of Object.keys(worldDefinitions))
			for (const profile of [
				'coincident',
				'inactive',
				'uint-identities',
				'fallback',
				'metric-self',
				'metric-neighbor',
				'metric-difference',
				...model.BEHAVIORS.map((behavior) => `behavior-${behavior}`)
			])
				await runCase(64, domain, 'dense', profile);
	if (!process.argv.includes('--gates-only')) {
		for (const domain of ['box', 'sphere'])
			for (const count of [5000, 10000, 20000])
				await runCase(count, domain, 'ordinary', 'default', true);
		for (const domain of ['box', 'sphere'])
			for (const count of [1000, 5000]) await runCase(count, domain, 'dense', 'default', true);
	}
	await gpu.settled();
	assert.deepEqual(errors, [], 'No GPU errors');
	console.log(`Hot-record experiment complete: ${resultFile}`);
} finally {
	await device.queue.onSubmittedWorkDone();
	querySet.destroy();
	queryResolve.destroy();
	queryRead.destroy();
	await gpu.dispose();
}
