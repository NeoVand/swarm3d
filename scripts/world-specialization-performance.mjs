import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init } from 'vgpu/node';

// Diagnostic only: a bounded five-world specialization of the same physical
// solver. All passes share immutable state, completed metrics and scatter order.
// --prepare-only resolves WGSL without acquiring or validating against a device.
const require = createRequire(import.meta.url);
const dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const folder = '.cache/world-specialization-sources';
await mkdir(folder, { recursive: true });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const raw = Object.fromEntries(
	await Promise.all(
		['common', 'grid', 'simulate', 'metrics'].map(async (name) => [
			name,
			await readFile(`src/lib/gpu/shaders/${name}.wgsl`, 'utf8')
		])
	)
);
const worldHelper = `@id(0) override fixed_world: u32=8u;
fn world_kind() -> f32 {
  if (fixed_world<8u) { return f32(fixed_world); }
  return config[0].z;
}
`;
let baseline = raw.simulate;
if (baseline.includes('fn world_kind(')) {
	assert.equal(baseline.split(worldHelper).length - 1, 1, 'Unique adopted world helper');
	baseline = baseline.replace(worldHelper, '').replaceAll('world_kind()', 'config[0].z');
	assert.ok(!baseline.includes('fixed_world'), 'Original generic source reconstructed');
}
const references = baseline.split('config[0].z').length - 1;
assert.ok(references > 10, 'All simulation geometry references found');
let specialized = baseline.replaceAll('config[0].z', 'world_kind()');
const firstLine = specialized.indexOf('\n') + 1;
specialized = specialized.slice(0, firstLine) + worldHelper + specialized.slice(firstLine);
if (raw.simulate.includes('fixed_world'))
	assert.equal(
		specialized.replace(/\s/g, ''),
		raw.simulate.replace(/\s/g, ''),
		'Candidate matches adopted shader source'
	);
await writeFile(`${folder}/common.wgsl`, raw.common);
for (const [name, source] of Object.entries({
	grid: raw.grid,
	metrics: raw.metrics,
	baseline,
	candidate: specialized
}))
	await writeFile(`${folder}/${name}.wgsl`, source);
const sources = {};
for (const name of ['grid', 'metrics', 'baseline', 'candidate'])
	sources[name] = (
		await resolveShader({ entry: resolve(`${folder}/${name}.wgsl`), validate: false })
	).wgsl;
const sourceHashes = Object.fromEntries(
	Object.entries(raw).map(([name, code]) => [name, sha256(code)])
);
const candidateHash = sha256(specialized);
const reconstructedBaselineHash = sha256(baseline);
if (process.argv.includes('--prepare-only')) {
	console.log(
		JSON.stringify(
			{
				prepared: true,
				sourceHashes,
				candidateHash,
				reconstructedBaselineHash,
				replacedGeometryReferences: references,
				acquiredGPU: false
			},
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
const gridEntries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
const pipelines = {
	grid: await Promise.all(
		gridEntries.map((entryPoint) => pipeline(sources.grid, layouts.grid, entryPoint))
	),
	metrics: await pipeline(sources.metrics, layouts.metrics, 'measure', { 0: 1, 1: 0 }),
	baseline: await pipeline(sources.baseline, layouts.simulate, 'simulate'),
	genericHelper: await pipeline(sources.candidate, layouts.simulate, 'simulate', { 0: 8 }),
	candidates: await Promise.all(
		Array.from({ length: 5 }, (_, code) =>
			pipeline(sources.candidate, layouts.simulate, 'simulate', { 0: code })
		)
	)
};
const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
const queryResolve = device.createBuffer({ size: 256, usage: 512 | 4 });
const queryRead = device.createBuffer({ size: 16, usage: 1 | 8 });
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const worldDefinitions = {
	box: { kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' },
	sphere: { kind: 'surface', shape: 'sphere', radius: 16 },
	plane: { kind: 'surface', shape: 'plane', halfExtents: [18, 18], boundaries: 'reflect' },
	cylinder: { kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 14 },
	torus: { kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 }
};
const domainCode = Object.fromEntries(
	Object.keys(worldDefinitions).map((name, code) => [name, code])
);
const results = {
	recordedAt: new Date().toISOString(),
	sourceHashes,
	candidateHash,
	reconstructedBaselineHash,
	replacedGeometryReferences: references,
	vgpu: '0.5.0',
	adapter: device.adapterInfo,
	method: {
		work: 'Immutable production simulation dispatch only; identical particle state, completed metrics and exact ordered spatial index. Excludes indexing, measurement, history, rendering and browser presentation.',
		timing:
			'GPU compute-pass timestamps over eight repeated immutable dispatches per sample, divided by eight. Alternating ten baseline/candidate pairs, actual queue settlement after each sample.',
		optimization:
			'One fixed world-kind override substitutes every simulation config[0].z geometry argument; five bounded variants remove unreachable world branches while retaining exact formulas, neighbor/order/state and bindings.',
		warmups: 3,
		pairedSamples: 10,
		dispatchesPerTimestamp: 8,
		gate: 'Require exact stable identities and finite physical values within5e-6*max(1,abs(reference)); separately record strict bitwise parity and ULP differences against original. A failed strict parity gate prohibits automatic production adoption.'
	},
	controls: [],
	cases: []
};
const outputFile = process.argv.includes('--gates-only')
	? '.cache/world-specialization-gates.json'
	: '.cache/world-specialization-performance.json';
function makeScene(count, domain, profile) {
	const scene = model.resizePopulation(model.createDefaultScene(), count);
	scene.seed = 0xc37ae19b;
	scene.world = structuredClone(worldDefinitions[domain]);
	if (domain === 'torus') {
		for (const species of scene.species) species.perception = 2;
		scene.forces.radius = 2;
	}
	if (profile === 'periodic' && (domain === 'box' || domain === 'plane'))
		scene.world.boundaries = 'periodic';
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
	} else if (profile === 'mixed') {
		a.metricRules = [rule('neighbor', 'chase'), rule('self', 'align')];
		b.metricRules = [rule('difference', 'mirror')];
		scene.speciesRules = [
			pair(a.key, '*', 'flee'),
			pair(a.key, b.key, 'ignore'),
			pair(b.key, '*', 'chase')
		];
	} else if (profile === 'coincident')
		scene.speciesRules = [pair(a.key, b.key, 'disperse'), pair(b.key, a.key, 'mob')];
	model.assertScene(scene);
	return scene;
}
function compress(agent, domain) {
	if (domain === 'box' || domain === 'plane') agent.position = agent.position.map((v) => v * 0.015);
	else if (domain === 'sphere') {
		const cap = [agent.position[0] * 0.01, agent.position[1] * 0.01, 16];
		const scale = 16 / Math.hypot(...cap);
		agent.position = cap.map((v) => v * scale);
		agent.velocity = model.tangentProjection(agent.velocity, agent.position);
	} else if (domain === 'cylinder') {
		const angle = Math.atan2(agent.position[2], agent.position[0]) * 0.015;
		agent.position = [12 * Math.cos(angle), agent.position[1] * 0.015, 12 * Math.sin(angle)];
		agent.velocity = model.tangentProjection(agent.velocity, [
			agent.position[0],
			0,
			agent.position[2]
		]);
	} else {
		const theta =
			Math.atan2(agent.position[1], Math.hypot(agent.position[0], agent.position[2]) - 20) * 0.015;
		const phi = Math.atan2(agent.position[2], agent.position[0]) * 0.015;
		const radial = 20 + 8 * Math.cos(theta);
		agent.position = [radial * Math.cos(phi), 8 * Math.sin(theta), radial * Math.sin(phi)];
		agent.velocity = model.tangentProjection(agent.velocity, [
			Math.cos(theta) * Math.cos(phi),
			Math.sin(theta),
			Math.cos(theta) * Math.sin(phi)
		]);
	}
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
	const value = Number(stamps[1] - stamps[0]) / 1e6 / results.method.dispatchesPerTimestamp;
	queryRead.unmap();
	assert.ok(value > 0 && Number.isFinite(value), 'Positive settled GPU timestamp interval');
	return value;
}
function dispatch(pass, pipeline, group, count) {
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, group);
	pass.dispatchWorkgroups(count);
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
	if (distribution === 'dense') for (const agent of agents) compress(agent, domain);
	if (profile === 'coincident') {
		for (const i of [1, scene.species[0].population]) {
			agents[i].position = [...agents[0].position];
			if (domain !== 'box') agents[i].velocity = [...agents[0].velocity];
		}
		agents[0].velocity = [0, 0, 0];
	}
	if (profile === 'periodic' && (domain === 'box' || domain === 'plane')) {
		const edge = 17.94;
		agents[0].position = [edge, 0, 0];
		agents[scene.species[0].population].position = [-edge, 0, 0];
	}
	const bytes = packing.packParticles(agents, scene, 1);
	if (profile === 'inactive') {
		const words = new Uint32Array(bytes);
		for (const i of [0, scene.species[0].population, count - 1]) words[i * 16 + 14] = 0;
	}
	const gridDefinition = packing.gridDefinition(scene);
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
	const b = {
		config: alloc('config', 16384),
		current: alloc('immutable particles', count * 64),
		prior: alloc('completed prior metrics', count * 64),
		measured: alloc('bootstrap metrics', count * 64),
		grid: alloc('complete grid', gridDefinition.count * 12 + 4),
		indices: alloc('complete indices', count * 4),
		blocks: alloc('prefix blocks', Math.ceil(gridDefinition.count / 256) * 4),
		species: alloc('species', scene.species.length * 1024),
		pairs: alloc('pair rules', scene.species.length ** 2 * 16),
		outputs: {
			baseline: alloc('baseline particles', count * 64),
			genericHelper: alloc('generic helper particles', count * 64),
			candidate: alloc('specialized particles', count * 64)
		}
	};
	const group = (layout, values) =>
		device.createBindGroup({
			layout,
			entries: values.map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
		});
	const bindings = {
		grid: group(layouts.grid, [b.config, b.current, b.grid, b.indices, b.blocks]),
		metrics: group(layouts.metrics, [
			b.config,
			b.current,
			b.prior,
			b.measured,
			b.grid,
			b.indices,
			b.species
		]),
		simulate: Object.fromEntries(
			Object.keys(b.outputs).map((variant) => [
				variant,
				group(layouts.simulate, [
					b.config,
					b.current,
					b.outputs[variant],
					b.grid,
					b.indices,
					b.prior,
					b.species,
					b.pairs
				])
			])
		)
	};
	const agentGroups = Math.ceil(count / 128),
		cellGroups = Math.ceil(gridDefinition.count / 256);
	const indexCounts = [
		cellGroups,
		Math.ceil(count / 256),
		cellGroups,
		1,
		cellGroups,
		Math.ceil(count / 256)
	];
	const chosen = {
		baseline: pipelines.baseline,
		genericHelper: pipelines.genericHelper,
		candidate: pipelines.candidates[domainCode[domain]]
	};
	const result = { count, domain, distribution, profile, inputHash: sha256(new Uint8Array(bytes)) };
	try {
		b.current.write(bytes);
		b.config.write(
			packing.packConfig(scene, {
				population: count,
				tick: 77,
				simulationTime: 77 * scene.dynamics.fixedDt,
				historyHead: 0,
				validHistory: 1,
				smoothingAlpha: 1,
				sampleHistory: false,
				metricMask: 32767
			})
		);
		b.species.write(packing.packSpecies(scene));
		b.pairs.write(packing.packPairRules(scene));
		await submit((pass) => {
			gridEntries.forEach((_, i) => {
				if (cellGroups === 1 && (i === 3 || i === 4)) return;
				dispatch(pass, pipelines.grid[i], bindings.grid, indexCounts[i]);
			});
			dispatch(pass, pipelines.metrics, bindings.metrics, agentGroups);
		});
		b.prior.write(await b.measured.read(count * 64));
		for (const variant of Object.keys(chosen))
			await submit((pass) =>
				dispatch(pass, chosen[variant], bindings.simulate[variant], agentGroups)
			);
		const baseline = new Uint32Array(await b.outputs.baseline.read(count * 64));
		result.gates = {};
		for (const variant of ['genericHelper', 'candidate']) {
			const actual = new Uint32Array(await b.outputs[variant].read(count * 64));
			const referenceFloats = new Float32Array(baseline.buffer),
				actualFloats = new Float32Array(actual.buffer);
			let differingWords = 0,
				maximumAbsoluteDifference = 0,
				maximumRelativeDifference = 0,
				maximumScaledDifference = 0,
				maximumULP = 0;
			const changedFields = {};
			const fieldNames = [
				'position.x',
				'position.y',
				'position.z',
				'position.w',
				'velocity.x',
				'velocity.y',
				'velocity.z',
				'velocity.w',
				'previousVelocity.x',
				'previousVelocity.y',
				'previousVelocity.z',
				'previousVelocity.w'
			];
			const ordered = (word) => (word & 0x80000000 ? ~word >>> 0 : (word | 0x80000000) >>> 0);
			for (let index = 0; index < baseline.length; index++) {
				if (index % 16 >= 12) {
					assert.equal(actual[index], baseline[index], `${domain} stable identity ${index}`);
					continue;
				}
				assert.ok(
					Number.isFinite(referenceFloats[index]) && Number.isFinite(actualFloats[index]),
					`${domain} finite field ${index}`
				);
				const difference = Math.abs(actualFloats[index] - referenceFloats[index]);
				assert.ok(
					difference <= 5e-6 * Math.max(1, Math.abs(referenceFloats[index])),
					`${domain} numeric parity ${index}: ${referenceFloats[index]} vs ${actualFloats[index]}`
				);
				maximumAbsoluteDifference = Math.max(maximumAbsoluteDifference, difference);
				maximumRelativeDifference = Math.max(
					maximumRelativeDifference,
					difference / Math.max(1e-12, Math.abs(referenceFloats[index]))
				);
				maximumScaledDifference = Math.max(
					maximumScaledDifference,
					difference / Math.max(1, Math.abs(referenceFloats[index]))
				);
				if (actual[index] !== baseline[index]) {
					differingWords++;
					const field = fieldNames[index % 16];
					changedFields[field] = (changedFields[field] ?? 0) + 1;
					maximumULP = Math.max(
						maximumULP,
						Math.abs(ordered(actual[index]) - ordered(baseline[index]))
					);
				}
			}
			result.gates[variant] = {
				bitwiseIdentical: differingWords === 0,
				differingWords,
				maximumAbsoluteDifference,
				maximumRelativeDifference,
				maximumScaledDifference,
				maximumULP,
				identityExact: true,
				changedFields
			};
		}
		result.bitwiseIdentical =
			result.gates.genericHelper.bitwiseIdentical && result.gates.candidate.bitwiseIdentical;
		const productionVariant =
			domainCode[domain] >= 1 && domainCode[domain] <= 3 ? 'candidate' : 'genericHelper';
		result.productionGate = {
			worldOverride: productionVariant === 'candidate' ? domainCode[domain] : 5,
			...result.gates[productionVariant]
		};
		assert.equal(
			result.productionGate.bitwiseIdentical,
			true,
			`${domain} adopted solver retains original strict bitwise output`
		);
		const measured = new Float32Array(await b.measured.read(count * 64));
		const neighborCounts = Array.from({ length: count }, (_, i) => measured[i * 16 + 3]);
		result.meanNeighbors = neighborCounts.reduce((sum, n) => sum + n, 0) / count;
		result.maximumNeighbors = Math.max(...neighborCounts);
		if (timed) {
			for (let warm = 0; warm < results.method.warmups; warm++)
				for (const variant of ['baseline', 'candidate'])
					await submit((pass) => {
						for (let repeat = 0; repeat < results.method.dispatchesPerTimestamp; repeat++)
							dispatch(pass, chosen[variant], bindings.simulate[variant], agentGroups);
					});
			const samples = { baseline: [], candidate: [] };
			for (let pair = 0; pair < results.method.pairedSamples; pair++)
				for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
					samples[variant].push(
						await submit((pass) => {
							for (let repeat = 0; repeat < results.method.dispatchesPerTimestamp; repeat++)
								dispatch(pass, chosen[variant], bindings.simulate[variant], agentGroups);
						}, true)
					);
			result.baselineMedianMs = median(samples.baseline);
			result.candidateMedianMs = median(samples.candidate);
			result.reductionFraction = 1 - result.candidateMedianMs / result.baselineMedianMs;
			result.samples = samples;
			console.log(
				`${domain} ${distribution} ${count}: ${result.baselineMedianMs.toFixed(3)} → ${result.candidateMedianMs.toFixed(3)} ms (${(100 * result.reductionFraction).toFixed(1)}%), strict parity ${result.bitwiseIdentical}, max diff ${result.gates.candidate.maximumAbsoluteDifference}`
			);
		} else
			console.log(
				`CONTROL ${domain} ${profile}: strict parity ${result.bitwiseIdentical}, max diff ${result.gates.candidate.maximumAbsoluteDifference}, max neighbors ${result.maximumNeighbors}`
			);
		(timed ? results.cases : results.controls).push(result);
		await writeFile(outputFile, `${JSON.stringify(results, null, 2)}\n`);
	} finally {
		await device.queue.onSubmittedWorkDone();
		for (const buffer of owned) buffer.destroy();
	}
}
try {
	for (const domain of Object.keys(worldDefinitions))
		for (const profile of [
			'mixed',
			'coincident',
			'inactive',
			'periodic',
			...model.BEHAVIORS.map((behavior) => `behavior-${behavior}`)
		])
			await runCase(64, domain, 'dense', profile);
	if (!process.argv.includes('--gates-only')) {
		for (const domain of ['box', 'sphere'])
			for (const count of [10000, 20000]) await runCase(count, domain, 'ordinary', 'default', true);
		for (const domain of ['box', 'sphere']) await runCase(5000, domain, 'dense', 'default', true);
		for (const domain of ['plane', 'cylinder', 'torus'])
			await runCase(5000, domain, 'ordinary', 'default', true);
	}
	await gpu.settled();
	assert.deepEqual(errors, [], 'No GPU errors');
	console.log(`World specialization complete: ${outputFile}`);
} finally {
	await device.queue.onSubmittedWorkDone();
	querySet.destroy();
	queryResolve.destroy();
	queryRead.destroy();
	await gpu.dispose();
}
