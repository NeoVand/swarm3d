import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { init, compute } from 'vgpu/node';

// Run only in the team's exclusive GPU lane. Source-derived reproducible gate:
// node scripts/neighbor-strips.mjs --prepare-only    (no GPU initialization)
// node scripts/neighbor-strips.mjs                   (all five worlds, width1)
// node scripts/neighbor-strips.mjs --width-ratio=0.5 (same-width paired strips)
// node scripts/neighbor-strips.mjs --width-matrix    (interleaved width comparison)
// Strips is from https://eprints.whiterose.ac.uk/id/eprint/153625/7/1-s2.0-S0743731519301340-main.pdf
// Exact endpoints preserve complete CSR membership and neighbor arithmetic order.
// This isolates immutable dispatches,
// not interactive FPS: simulation never feeds its output back into the next sample.
// Both variants share the same complete grid, neighbor order, inputs and bindings.
// Standard WebGPU pass timestamps exclude CPU encoding, fences and query readback.
const require = createRequire(import.meta.url);
const dependencyRoot = dirname(require.resolve('vgpu'));
const { resolveShader } = await import(
	pathToFileURL(require.resolve('@vgpu/wgsl/runtime', { paths: [dependencyRoot] })).href
);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let model, packing;
try {
	model = await vite.ssrLoadModule('/src/lib/model/index.ts');
	packing = await vite.ssrLoadModule('/src/lib/gpu/packing.ts');
} finally {
	await vite.close();
}
const adaptiveOrder = true;
let widthRatio = Number(
	process.argv.find((v) => v.startsWith('--width-ratio='))?.split('=')[1] ?? 1
);
assert.ok(widthRatio > 0 && widthRatio <= 1);
const orderOnly = process.argv.includes('--order-only') || adaptiveOrder;
const orderedObservers = process.argv.includes('--ordered-observers') || orderOnly;
const widthMatrix = process.argv.includes('--width-matrix');
const resultSuffix = widthMatrix ? '-strips-width-matrix' : `-strips-width-${widthRatio}`;
const METRIC_BYTES = packing.METRIC_BYTES;
const METRIC_STRIDE = METRIC_BYTES / Float32Array.BYTES_PER_ELEMENT;

const sources = Object.fromEntries(
	await Promise.all(
		['grid', 'simulate', 'metrics'].map(async (name) => [
			name,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`), validate: false }))
				.wgsl
		])
	)
);

// Source snippets ignore whitespace so adoption/formatting does not make this
// experiment depend on an ignored cache snapshot or a historic Git checkout.
function replaceOnce(source, from, to) {
	let compact = '';
	const offsets = [];
	for (let i = 0; i < source.length; i++) {
		if (/\s/.test(source[i])) continue;
		compact += source[i];
		offsets.push(i);
	}
	const marker = from.replace(/\s/g, '');
	assert.ok(marker.length > 0, 'nonempty source marker');
	assert.equal(compact.split(marker).length - 1, 1, `unique source marker: ${from}`);
	const start = compact.indexOf(marker),
		end = start + marker.length;
	return source.slice(0, offsets[start]) + to + source.slice(offsets[end - 1] + 1);
}
function indentShader(source) {
	let depth = 0;
	const formatted = source.split('\n').map((raw) => {
		const line = raw.trim();
		if (!line) return '';
		const code = line.split('//')[0];
		const leadingClosures = code.match(/^}+/)?.[0].length ?? 0;
		const result = `${'  '.repeat(Math.max(0, depth - leadingClosures))}${line}`;
		depth += (code.match(/{/g)?.length ?? 0) - (code.match(/}/g)?.length ?? 0);
		assert.ok(depth >= 0, 'balanced shader indentation');
		return result;
	});
	assert.equal(depth, 0, 'complete shader indentation');
	return `${formatted
		.join('\n')
		.trim()
		.replace(/\n(?:[ \t]*\n)+/g, '\n\n')
		.replace(/{\n\n/g, '{\n')
		.replace(/\n\n(?=[ \t]*})/g, '\n')}\n`;
}
// The candidate preserves every accepted neighbor and every force formula.
// Only simulation-source evaluation work changes; grid and measurement are shared.
async function variants() {
	let current = await readFile('src/lib/gpu/shaders/simulate.wgsl', 'utf8');
	const from = `      for (var ix=0u; ix<xs.count+xs.extraCount; ix++) {
        let x=span_cell(xs,ix);
        let cell=x+dims.x*(y+dims.y*z);
        let offset=grid[u32(config[3].w)+cell];
        for (var j=0u; j<grid[cell]; j++) {
          let neighborIndex=indices[offset+j];`;
	const to = `      // X-major CSR fragments retain the exact visitation/summation order.
      for (var fragment=0u; fragment<select(1u,2u,xs.extraCount>0u); fragment++) {
        let firstX=select(xs.lo,xs.extraLo,fragment>0u);
        let countX=select(xs.count,xs.extraCount,fragment>0u);
        let firstCell=firstX+dims.x*(y+dims.y*z);
        let lastCell=firstCell+countX-1u;
        let begin=grid[u32(config[3].w)+firstCell];
        let end=grid[u32(config[3].w)+lastCell]+grid[lastCell];
        for (var neighborSlot=begin; neighborSlot<end; neighborSlot++) {
          let neighborIndex=indices[neighborSlot];`;
	if (current.includes('let neighborIndex=indices[neighborSlot];')) {
		current = current.replace(
			'      // X-major CSR fragments retain the exact visitation/summation order.\n      // A periodic seam has two disjoint strips, visited in the original order.\n',
			''
		);
		current = replaceOnce(
			current,
			to.replace(
				'      // X-major CSR fragments retain the exact visitation/summation order.\n',
				''
			),
			from
		);
	}
	const candidate = replaceOnce(current, from, to);
	assert.equal(replaceOnce(candidate, to, from).replace(/\s/g, ''), current.replace(/\s/g, ''));
	const folder = '.cache/neighbor-strips';
	await mkdir(folder, { recursive: true });
	const resolved = {};
	for (const [label, code] of Object.entries({ baseline: current, candidate })) {
		const entry = `${folder}/simulate-${label}.wgsl`;
		await writeFile(
			entry,
			indentShader(code).replace('"./common.wgsl"', '"../../src/lib/gpu/shaders/common.wgsl"')
		);
		resolved[label] = (await resolveShader({ entry: resolve(entry), validate: false })).wgsl;
	}
	return resolved;
}
const shaders = {
	simulate: await variants(),
	metrics: { baseline: sources.metrics, candidate: sources.metrics },
	index: { baseline: sources.grid, candidate: sources.grid }
};
let cpuGateCases = 0;
for (let trial = 0; trial < 1000; trial++) {
	const dim = 1 + (trial % 37),
		counts = new Uint32Array(dim),
		offsets = new Uint32Array(dim);
	let running = 0;
	for (let c = 0; c < dim; c++) {
		offsets[c] = running;
		counts[c] = (trial * 17 + c * 13) % 19;
		running += counts[c];
	}
	const lo = trial % dim,
		n = 1 + ((trial * 7) % (dim - lo)),
		extra = trial % 3 === 0 ? lo : 0;
	const spans = [[lo, n], ...(extra > 0 ? [[0, extra]] : [])],
		ordinary = [],
		stripped = [];
	for (const [start, count] of spans)
		for (let c = start; c < start + count; c++)
			for (let i = 0; i < counts[c]; i++) ordinary.push(offsets[c] + i);
	for (const [start, count] of spans)
		for (let i = offsets[start]; i < offsets[start + count - 1] + counts[start + count - 1]; i++)
			stripped.push(i);
	assert.deepEqual(stripped, ordinary);
	cpuGateCases++;
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (process.argv.includes('--prepare-only')) {
	console.log(
		JSON.stringify(
			{
				prepared: true,
				shaderHashes: Object.fromEntries(
					Object.entries(shaders).map(([k, v]) => [
						k,
						{ baseline: sha256(v.baseline), candidate: sha256(v.candidate) }
					])
				)
			},
			null,
			2
		)
	);
	process.exit(0);
}

let gpu;
try {
	gpu = await init({
		requiredFeatures: ['timestamp-query'],
		requiredLimits: { maxStorageBuffersPerShaderStage: 8 }
	});
} catch (error) {
	assert.match(
		String(error),
		/FEATURE-UNSUPPORTED|timestamp-query/,
		'fallback only for unsupported timestamp queries'
	);
	gpu = await init({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
}
const device = gpu.gpu;
const errors = [];
gpu.onError((error) => errors.push(String(error)));
device.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));
const timestampEnabled = device.features.has('timestamp-query');
const querySet = timestampEnabled ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
// These are the standard GPUBufferUsage/GPUMapMode flags, including providers
// that expose WebGPU objects without installing the browser's global constants.
const queryResolve = timestampEnabled ? device.createBuffer({ size: 256, usage: 512 | 4 }) : null;
const queryRead = timestampEnabled ? device.createBuffer({ size: 16, usage: 1 | 8 }) : null;
const results = {
	recordedAt: new Date().toISOString(),
	orderedObservers,
	orderOnly,
	adaptiveOrder,
	widthRatio,
	cpuGateCases,
	vgpu: '0.5.0',
	adapter: {
		description: device.adapterInfo?.description,
		device: device.adapterInfo?.device,
		architecture: device.adapterInfo?.architecture
	},
	method: {
		work: 'Isolated immutable production simulation and dynamic-mask measurement dispatches requesting all fields; same frozen complete grid and ordered neighbors. Measurement override defaults remain0; runtime complete/unit-family specialization is not timed. Excludes history, rendering and interactive scheduling; indexing is timed separately.',
		timing: timestampEnabled
			? 'Beginning/end compute-pass GPU timestamps, nanoseconds converted to milliseconds. Each sample waits actual queue settlement and query readback; one dispatch in flight.'
			: 'Serial CPU submit-to-actual-queue-settlement latency; GPU timestamps unavailable. Includes driver/submission overhead.',
		warmupDispatchesPerVariant: 3,
		pairedSamplesPerKernel: 12,
		indexTimestampRepetitions: 32,
		order:
			'Alternating baseline/candidate then candidate/baseline; box and sphere 5k/10k/20k, dense 5k/10k, and the actual user box at 10,400 agents.',
		optimization:
			'Exact X-major contiguous CSR strips. Same frozen adaptive observer order. Width varies only across separate runs; complete cell count limit retained.',
		outputGate:
			'Every Float32 output finite and within 4e-6*max(1,abs(reference)); particle identities and neighbor counts exact. Shared immutable grid removes atomic scatter-order differences.'
	},
	shaderHashes: Object.fromEntries(
		Object.entries(shaders).map(([k, v]) => [
			k,
			{ baseline: sha256(v.baseline), candidate: sha256(v.candidate) }
		])
	),
	cases: [],
	untimedControls: []
};
const layouts = {
	index: ['read-only-storage', 'read-only-storage', 'storage', 'storage', 'storage'],
	simulate: [
		'read-only-storage',
		'read-only-storage',
		'storage',
		'read-only-storage',
		'read-only-storage',
		'read-only-storage',
		'read-only-storage',
		'read-only-storage'
	],
	metrics: [
		'read-only-storage',
		'read-only-storage',
		'read-only-storage',
		'storage',
		'read-only-storage',
		'read-only-storage',
		'read-only-storage'
	]
};
const pipelines = {};
async function makePipeline(kernel, label, code) {
	const module = device.createShaderModule({ label: `${kernel} ${label}`, code });
	const messages = (await module.getCompilationInfo()).messages.filter(
		(message) => message.type === 'error'
	);
	assert.equal(messages.length, 0, messages.map((m) => `${m.lineNum}:${m.message}`).join('\n'));
	const layout = device.createBindGroupLayout({
		entries: layouts[kernel].map((type, binding) => ({ binding, visibility: 4, buffer: { type } }))
	});
	const pipeline = await device.createComputePipelineAsync({
		label: `${kernel} ${label}`,
		layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
		compute: { module, entryPoint: kernel === 'metrics' ? 'measure' : 'simulate' }
	});
	return { pipeline, layout };
}
const gridEntries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
];
async function makeIndexPipeline(label, code) {
	const module = device.createShaderModule({ label: `index ${label}`, code });
	const diagnostics = (await module.getCompilationInfo()).messages.filter(
		(m) => m.type === 'error'
	);
	assert.deepEqual(diagnostics, [], 'adaptive index WGSL compile');
	const layout = device.createBindGroupLayout({
		entries: layouts.index.map((type, binding) => ({ binding, visibility: 4, buffer: { type } }))
	});
	const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
	return {
		layout,
		pipelines: await Promise.all(
			gridEntries.map((entryPoint) =>
				device.createComputePipelineAsync({
					label: `${entryPoint} ${label}`,
					layout: pipelineLayout,
					compute: { module, entryPoint }
				})
			)
		)
	};
}
const gridPasses = Object.fromEntries(
	gridEntries.map((entry) => [entry, compute(gpu, sources.grid, { entry })])
);
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length % 2
		? sorted[Math.floor(sorted.length / 2)]
		: (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const percentile = (values, fraction) =>
	[...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
function outputGate(kernel, baseline, candidate, count) {
	assert.equal(baseline.byteLength, candidate.byteLength);
	const a = new Float32Array(baseline),
		b = new Float32Array(candidate);
	const ua = new Uint32Array(baseline),
		ub = new Uint32Array(candidate);
	let maxAbsoluteDifference = 0,
		differingFloatWords = 0;
	for (let index = 0; index < a.length; index++) {
		if (kernel === 'simulate' && index % 16 >= 12) {
			assert.equal(ub[index], ua[index], `particle identity ${index}`);
			continue;
		}
		assert.ok(Number.isFinite(a[index]) && Number.isFinite(b[index]), `${kernel} finite ${index}`);
		const difference = Math.abs(b[index] - a[index]);
		assert.ok(
			difference <= 4e-6 * Math.max(1, Math.abs(a[index])),
			`${kernel} field ${index}: ${a[index]} vs ${b[index]}`
		);
		maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
		if (ua[index] !== ub[index]) differingFloatWords++;
	}
	if (kernel === 'metrics')
		for (let i = 0; i < count; i++)
			assert.equal(
				b[i * METRIC_STRIDE + 3],
				a[i * METRIC_STRIDE + 3],
				`complete neighbor count ${i}`
			);
	return {
		maxAbsoluteDifference,
		differingFloatWords,
		bitwiseIdentical: differingFloatWords === 0
	};
}
async function dispatch(kernel, variant, group, count, timed = true) {
	const start = performance.now();
	const repeats = kernel === 'index' && timed ? 32 : 1;
	const encoder = device.createCommandEncoder({ label: `${kernel} ${variant} frozen sample` });
	const pass = encoder.beginComputePass(
		timed && querySet
			? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
			: {}
	);
	if (kernel === 'index') {
		const cellGroups = Math.ceil(count.cells / 256),
			agentGroups = Math.ceil(count.population / 256);
		const dispatchCounts = [cellGroups, agentGroups, cellGroups, 1, cellGroups, agentGroups];
		for (let repeat = 0; repeat < repeats; repeat++)
			for (let i = 0; i < gridEntries.length; i++) {
				if (cellGroups === 1 && (i === 3 || i === 4)) continue;
				pass.setPipeline(pipelines.index[variant].pipelines[i]);
				pass.setBindGroup(0, group);
				pass.dispatchWorkgroups(dispatchCounts[i]);
			}
	} else {
		pass.setPipeline(pipelines[kernel][variant].pipeline);
		pass.setBindGroup(0, group);
		pass.dispatchWorkgroups(Math.ceil(count / 128));
	}
	pass.end();
	if (timed && querySet) {
		encoder.resolveQuerySet(querySet, 0, 2, queryResolve, 0);
		encoder.copyBufferToBuffer(queryResolve, 0, queryRead, 0, 16);
	}
	device.queue.submit([encoder.finish()]);
	await device.queue.onSubmittedWorkDone();
	const completedMs = (performance.now() - start) / repeats;
	if (!timed || !querySet) return { gpuMs: null, completedMs };
	await queryRead.mapAsync(1);
	const stamps = new BigUint64Array(queryRead.getMappedRange());
	const gpuMs = Number(stamps[1] - stamps[0]) / 1e6 / repeats;
	queryRead.unmap();
	assert.ok(gpuMs > 0 && Number.isFinite(gpuMs), 'positive settled GPU timestamp interval');
	return { gpuMs, completedMs };
}
async function runCase(
	count,
	domain,
	distribution = 'ordinary',
	profile = 'default',
	timed = true
) {
	const scene = model.resizePopulation(model.createDefaultScene(), count);
	scene.seed = distribution === 'user' ? 73419 : 0xc37ae19b;
	scene.world = {
		box: { kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' },
		sphere: { kind: 'surface', shape: 'sphere', radius: 16 },
		plane: { kind: 'surface', shape: 'plane', halfExtents: [18, 18], boundaries: 'reflect' },
		cylinder: { kind: 'surface', shape: 'cylinder', radius: 16, halfHeight: 12 },
		torus: { kind: 'surface', shape: 'torus', majorRadius: 32, tubeRadius: 16 }
	}[domain];
	if (profile === 'periodic' || profile === 'wide-periodic') {
		assert.ok(domain === 'box' || domain === 'plane');
		scene.world.boundaries = 'periodic';
		scene.world.halfExtents = domain === 'box' ? [17.3, 11.7, 18.2] : [17.3, 18.2];
		if (profile === 'wide-periodic') for (const s of scene.species) s.perception = 40;
	}

	if (distribution === 'user') {
		scene.species[0].population = 5700;
		scene.species[1].population = count - 5700;
		scene.species[0].perception = 3.2;
		scene.species[1].perception = 4;
		scene.species[0].speed = 3.7;
		scene.species[0].cruiseSpeed = 0.8;
		scene.species[1].speed = 3.1;
		scene.species[1].cruiseSpeed = 3.1;
	}
	if (profile !== 'default') {
		const [a, b] = scene.species;
		const pair = (from, to, behavior, strength) => ({
			id: `${from}-${to === '*' ? 'all' : to}-${behavior}`,
			from,
			to,
			behavior,
			strength,
			radius: null
		});
		const rule = (metric, role, behavior, strength) => ({
			id: `${metric}-${role}-${behavior}`,
			metric,
			role,
			behavior,
			strength,
			radius: null,
			range: metric === 'heading-azimuth' ? [0, 1] : [0, a.speed],
			curve: model.curvePreset('linear')
		});
		if (['inactive', 'missing-metadata', 'periodic', 'wide-periodic'].includes(profile)) {
			// Retain default Flee relationships; vary only runtime index completeness.
		} else if (profile.startsWith('behavior-')) {
			const behavior = profile.slice('behavior-'.length);
			assert.ok(model.BEHAVIORS.includes(behavior));
			scene.speciesRules = [pair(a.key, b.key, behavior, 0.6), pair(b.key, a.key, behavior, 0.4)];
		} else if (profile === 'coincident') {
			scene.speciesRules = [pair(a.key, b.key, 'disperse', 0.6), pair(b.key, a.key, 'mob', 0.4)];
		} else if (profile === 'directed')
			scene.speciesRules = [pair(a.key, b.key, 'align', 0.6), pair(b.key, a.key, 'mirror', 0.4)];
		else if (profile === 'metric') {
			a.metricRules = [rule('speed', 'neighbor', 'flee', 0.4)];
			b.metricRules = [rule('heading-azimuth', 'difference', 'orbit', 0.3)];
		} else if (profile === 'mixed') {
			scene.speciesRules = [pair(b.key, a.key, 'chase', 0.5)];
			b.metricRules = [rule('speed', 'self', 'align', 0.3)];
		} else {
			assert.equal(profile, 'muted');
			scene.speciesRules = [pair(a.key, '*', 'chase', 0), pair(b.key, '*', 'ignore', 1)];
			a.metricRules = [rule('speed', 'neighbor', 'ignore', 1)];
			b.metricRules = [rule('speed', 'self', 'flee', 0)];
		}
	}
	model.assertScene(scene);
	const agents = model.initializePopulation(scene).agents;
	if (distribution === 'dense') {
		const anchor = {
			box: [0, 0, 0],
			plane: [0, 0, 0],
			sphere: [0, 0, 16],
			cylinder: [0, 0, 16],
			torus: [48, 0, 0]
		}[domain];
		for (const agent of agents) {
			agent.position =
				domain === 'box' || domain === 'plane'
					? agent.position.map((v) => v * 0.015)
					: model.worldExp(
							scene.world,
							anchor,
							model.worldTangent(scene.world, model.scale(agent.velocity, 0.015), anchor)
						);
			agent.velocity = model.worldTangent(scene.world, agent.velocity, agent.position);
		}
	}
	if (profile === 'coincident') {
		for (const i of [1, scene.species[0].population]) {
			agents[i].position = [...agents[0].position];
			agents[i].velocity = model.worldTangent(scene.world, agents[i].velocity, agents[i].position);
		}
		agents[0].velocity = [0, 0, 0];
	}
	if (profile === 'periodic' || profile === 'wide-periodic') {
		const half = model.worldBounds(scene.world);
		for (let i = 0; i < agents.length; i++) {
			const signs = [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
			agents[i].position = half.map((h, axis) =>
				h === 0 ? 0 : signs[axis] * (h - 0.03 - 0.001 * (i % 17))
			);
			agents[i].velocity = model.worldTangent(scene.world, agents[i].velocity, agents[i].position);
		}
	}
	const definition = packing.gridDefinition(scene),
		originalWidth = definition.width;
	definition.width *= widthRatio;
	definition.dims = definition.half.map((v) => Math.max(1, Math.ceil((2 * v) / definition.width)));
	while (definition.dims.reduce((a, b) => a * b, 1) > 65536) {
		definition.width *= 1.1;
		definition.dims = definition.half.map((v) =>
			Math.max(1, Math.ceil((2 * v) / definition.width))
		);
	}
	definition.count = definition.dims.reduce((a, b) => a * b, 1);
	const owned = [];
	const alloc = (label, size) => {
		const b = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.push(b);
		return b;
	};
	const buffers = {
		config: alloc('frozen config', 16384),
		particles: alloc('frozen particles', count * 64),
		previousMetrics: alloc('frozen prior metrics', count * METRIC_BYTES),
		grid: alloc(
			'complete grid',
			definition.count * 12 + (adaptiveOrder && profile !== 'missing-metadata' ? 4 : 0)
		),
		indices: alloc('complete indices', count * 4),
		blocks: alloc('prefix blocks', Math.ceil(definition.count / 256) * 4),
		species: alloc('frozen species', scene.species.length * 1024),
		pairRules: alloc('frozen pair rules', scene.species.length ** 2 * 16),
		outputs: {
			simulate: {
				baseline: alloc('baseline particles', count * 64),
				candidate: alloc('candidate particles', count * 64)
			},
			metrics: {
				baseline: alloc('baseline metrics', count * METRIC_BYTES),
				candidate: alloc('candidate metrics', count * METRIC_BYTES)
			}
		}
	};
	try {
		const particles = packing.packParticles(agents, scene, 1);
		const inactiveSlots = profile === 'inactive' ? [0, scene.species[0].population, count - 1] : [];
		const words = new Uint32Array(particles);
		for (const slot of inactiveSlots) words[slot * 16 + 14] = 0;
		const activeCount = count - inactiveSlots.length;
		buffers.particles.write(particles);
		const config = packing.packConfig(
			scene,
			{
				population: count,
				tick: 77,
				simulationTime: 77 * scene.dynamics.fixedDt,
				historyHead: 0,
				validHistory: 1,
				smoothingAlpha: 1,
				sampleHistory: false
			},
			{ grid: definition, stride: packing.historyStride(scene) }
		);
		buffers.config.write(config);
		buffers.species.write(packing.packSpecies(scene));
		buffers.pairRules.write(packing.packPairRules(scene));
		for (const p of Object.values(gridPasses))
			p.set({
				config: buffers.config,
				particles: buffers.particles,
				grid: buffers.grid,
				indices: buffers.indices,
				blocks: buffers.blocks
			});
		const groups = Math.ceil(definition.count / 256);
		const gridDispatchCounts = [
			groups,
			Math.ceil(count / 256),
			groups,
			1,
			groups,
			Math.ceil(count / 256)
		];
		const indexBindings = adaptiveOrder
			? Object.fromEntries(
					['baseline', 'candidate'].map((variant) => [
						variant,
						device.createBindGroup({
							layout: pipelines.index[variant].layout,
							entries: [
								buffers.config,
								buffers.particles,
								buffers.grid,
								buffers.indices,
								buffers.blocks
							].map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
						})
					])
				)
			: {};
		if (adaptiveOrder)
			await dispatch(
				'index',
				'candidate',
				indexBindings.candidate,
				{ population: count, cells: definition.count },
				false
			);
		else {
			gridEntries.forEach((entry, i) => {
				if (groups !== 1 || (i !== 3 && i !== 4)) gridPasses[entry].dispatch(gridDispatchCounts[i]);
			});
		}
		await device.queue.onSubmittedWorkDone();
		const group = (kernel, variant) => {
			const output = buffers.outputs[kernel][variant];
			const inputs =
				kernel === 'metrics'
					? [
							buffers.config,
							buffers.particles,
							buffers.previousMetrics,
							output,
							buffers.grid,
							buffers.indices,
							buffers.species
						]
					: [
							buffers.config,
							buffers.particles,
							output,
							buffers.grid,
							buffers.indices,
							buffers.previousMetrics,
							buffers.species,
							buffers.pairRules
						];
			return device.createBindGroup({
				layout: pipelines[kernel][variant].layout,
				entries: inputs.map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
			});
		};
		const bindings = Object.fromEntries(
			['metrics', 'simulate'].map((k) => [
				k,
				{ baseline: group(k, 'baseline'), candidate: group(k, 'candidate') }
			])
		);
		await dispatch('metrics', 'baseline', bindings.metrics.baseline, count, false);
		// Bootstrap once, then use the SAME immutable measured metrics for both kernels.
		const measured = await buffers.outputs.metrics.baseline.read(count * METRIC_BYTES);
		buffers.previousMetrics.write(measured);
		const initial = new Float32Array(measured);
		const neighborCounts = Array.from({ length: count }, (_, i) => initial[i * METRIC_STRIDE + 3]);
		const gridBytes = await buffers.grid.read(definition.count * 12);
		const cellCounts = new Uint32Array(gridBytes, 0, definition.count);
		const indexed = new Uint32Array(await buffers.indices.read(activeCount * 4));
		assert.equal(
			new Set(indexed).size,
			activeCount,
			'scatter index is a complete active observer permutation'
		);
		for (const slot of indexed) {
			assert.ok(slot < count, 'observer index remains within stable state/history slots');
			assert.ok(!inactiveSlots.includes(slot), 'inactive holes are not in neighborhood index');
		}
		const orderFlag =
			adaptiveOrder && profile !== 'missing-metadata'
				? new Uint32Array(await buffers.grid.read(4, definition.count * 12))[0]
				: null;
		if (adaptiveOrder && orderFlag !== null)
			assert.equal(
				orderFlag,
				Math.max(...cellCounts) > 256 || inactiveSlots.length > 0 ? 1 : 0,
				'GPUmetadata adaptiveorder flag'
			);
		const result = {
			count,
			distribution: `${distribution}-${domain}`,
			world: scene.world,
			profile,
			inputSha256: sha256(new Uint8Array(particles)),
			gridSha256: sha256(new Uint8Array(gridBytes)),
			gridCells: definition.count,
			originalWidth,
			gridWidth: definition.width,
			orderFlag,
			activeCount,
			maximumCellPopulation: Math.max(...cellCounts),
			meanNeighbors: neighborCounts.reduce((a, b) => a + b, 0) / count,
			maximumNeighbors: Math.max(...neighborCounts),
			kernels: {}
		};
		for (const kernel of ['metrics', 'simulate']) {
			for (const variant of ['baseline', 'candidate'])
				await dispatch(kernel, variant, bindings[kernel][variant], count, false);
			const [baseline, candidate] = await Promise.all([
				buffers.outputs[kernel].baseline.read(count * (kernel === 'metrics' ? METRIC_BYTES : 64)),
				buffers.outputs[kernel].candidate.read(count * (kernel === 'metrics' ? METRIC_BYTES : 64))
			]);
			const gate = outputGate(kernel, baseline, candidate, count);
			if (!timed) {
				result.kernels[kernel] = { gate };
				console.log(
					`CONTROL ${domain} ${profile} ${kernel}: ${gate.bitwiseIdentical ? 'bitwise equal' : `max difference ${gate.maxAbsoluteDifference}`}`
				);
				continue;
			}
			for (let warmup = 0; warmup < results.method.warmupDispatchesPerVariant; warmup++)
				for (const variant of warmup % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
					await dispatch(kernel, variant, bindings[kernel][variant], count, false);
			const samples = { baseline: [], candidate: [] };
			for (let pair = 0; pair < results.method.pairedSamplesPerKernel; pair++)
				for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
					samples[variant].push(await dispatch(kernel, variant, bindings[kernel][variant], count));
			const milliseconds = (variant) =>
				samples[variant].map((s) => (timestampEnabled ? s.gpuMs : s.completedMs));
			const baselineMs = milliseconds('baseline'),
				candidateMs = milliseconds('candidate');
			const pairedChanges = baselineMs.map((value, i) => 1 - candidateMs[i] / value);
			result.kernels[kernel] = {
				gate,
				baselineMedianMs: median(baselineMs),
				candidateMedianMs: median(candidateMs),
				medianReductionFraction: 1 - median(candidateMs) / median(baselineMs),
				pairedMedianReductionFraction: median(pairedChanges),
				pairedP10ReductionFraction: percentile(pairedChanges, 0.1),
				pairedP90ReductionFraction: percentile(pairedChanges, 0.9),
				samples
			};
			console.log(
				`${result.distribution} ${count} ${kernel}: ${median(baselineMs).toFixed(3)} -> ${median(candidateMs).toFixed(3)} ms (${(100 * (1 - median(candidateMs) / median(baselineMs))).toFixed(1)}%); output ${gate.bitwiseIdentical ? 'bitwise equal' : `max difference ${gate.maxAbsoluteDifference}`}`
			);
		}
		if (adaptiveOrder) {
			// Whole index timing includes all six ordered compute dispatches. Both
			// variants rebuild from the same immutable particle data; neighbor order
			// after scatter need not match, but membership/counts must remain complete.
			const work = { population: count, cells: definition.count };
			await dispatch('index', 'baseline', indexBindings.baseline, work, false);
			const originalGrid = new Uint32Array(await buffers.grid.read(definition.count * 12));
			await dispatch('index', 'candidate', indexBindings.candidate, work, false);
			const adaptiveGrid = new Uint32Array(await buffers.grid.read(definition.count * 12));
			assert.deepEqual(
				adaptiveGrid,
				originalGrid,
				'index metadata does not change complete cell counts/offsets'
			);
			const membership = new Uint32Array(await buffers.indices.read(activeCount * 4));
			assert.equal(
				new Set(membership).size,
				activeCount,
				'adaptive scatter retains every active observer'
			);
			const samples = { baseline: [], candidate: [] };
			if (timed) {
				for (let warmup = 0; warmup < 3; warmup++)
					for (const variant of ['baseline', 'candidate'])
						await dispatch('index', variant, indexBindings[variant], work, false);
				for (let pair = 0; pair < 12; pair++)
					for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
						samples[variant].push(await dispatch('index', variant, indexBindings[variant], work));
				const values = (variant) =>
					samples[variant].map((v) => (timestampEnabled ? v.gpuMs : v.completedMs));
				result.kernels.index = {
					baselineMedianMs: median(values('baseline')),
					candidateMedianMs: median(values('candidate')),
					samples
				};
				console.log(
					`${result.distribution} ${count} whole index: ${result.kernels.index.baselineMedianMs.toFixed(3)} -> ${result.kernels.index.candidateMedianMs.toFixed(3)} ms`
				);
			} else result.kernels.index = { membershipExact: true };
		}
		(timed ? results.cases : results.untimedControls).push(result);
		await mkdir('.cache', { recursive: true });
		await writeFile(
			`.cache/neighbor-strips/performance${resultSuffix}.json`,
			`${JSON.stringify(results, null, 2)}\n`
		);
	} finally {
		await device.queue.onSubmittedWorkDone();
		for (const b of owned) b.destroy();
	}
}
try {
	for (const kernel of ['metrics', 'simulate']) {
		pipelines[kernel] = {};
		for (const variant of ['baseline', 'candidate'])
			pipelines[kernel][variant] = await makePipeline(kernel, variant, shaders[kernel][variant]);
	}
	if (adaptiveOrder) {
		pipelines.index = {};
		for (const variant of ['baseline', 'candidate'])
			pipelines.index[variant] = await makeIndexPipeline(variant, shaders.index[variant]);
	}
	if (widthMatrix) {
		for (let repetition = 0; repetition < 2; repetition++) {
			for (const [count, domain, distribution] of [
				[20000, 'box', 'ordinary'],
				[10000, 'box', 'dense'],
				[10400, 'box', 'user'],
				[10000, 'sphere', 'ordinary']
			]) {
				for (const width of repetition % 2 ? [0.5, 1] : [1, 0.5]) {
					widthRatio = width;
					await runCase(count, domain, distribution);
				}
			}
		}
	} else {
		for (const domain of ['box', 'sphere', 'plane', 'cylinder', 'torus'])
			for (const profile of [
				'directed',
				'metric',
				'mixed',
				'muted',
				'coincident',
				...(adaptiveOrder ? ['inactive', 'missing-metadata'] : []),
				...model.BEHAVIORS.map((b) => `behavior-${b}`)
			])
				await runCase(128, domain, 'ordinary', profile, false);
		for (const domain of ['box', 'plane'])
			for (const profile of ['periodic', 'wide-periodic'])
				await runCase(128, domain, 'ordinary', profile, false);
		for (const domain of ['box', 'sphere', 'plane', 'cylinder', 'torus'])
			for (const count of [5000, 10000, 20000]) await runCase(count, domain);
		for (const domain of ['box', 'sphere'])
			for (const count of [5000, 10000]) await runCase(count, domain, 'dense');
		await runCase(10400, 'box', 'user');
	}
	await device.queue.onSubmittedWorkDone();
	await gpu.settled();
	assert.deepEqual(errors, [], 'no GPU validation/readback errors');
	console.log(
		`Frozen exact-neighbor-work output/timing comparison complete; results: .cache/neighbor-strips/performance${resultSuffix}.json`
	);
} finally {
	await device.queue.onSubmittedWorkDone();
	querySet?.destroy();
	queryResolve?.destroy();
	queryRead?.destroy();
	await gpu.dispose();
}
