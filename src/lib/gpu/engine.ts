import { init, draw, effect, frame, sampler, surface, target, uniforms } from 'vgpu';
import type { Gpu } from 'vgpu';
import type { Buffer as CoreBuffer } from 'vgpu/core';
import {
	initializePopulation,
	reconcilePopulation,
	assertScene,
	worldNormal,
	worldBounds
} from '#lib/model';
import type { SceneDefinition, Vec3 } from '#lib/model';
import gridShader from './shaders/grid.wgsl';
import simulationShader from './shaders/simulate.wgsl';
import metricsShader from './shaders/metrics.wgsl';
import historyShader from './shaders/history.wgsl';
import boidShader from './shaders/boids.wgsl';
import trailShader from './shaders/trails.wgsl';
import worldShader from './shaders/world.wgsl';
import bloomShader from './shaders/bloom.wgsl';
import highlightShader from './shaders/highlights.wgsl';
import presentationShader from './shaders/presentation.wgsl';
import { pickWorldRay, StageCamera } from './camera';
import { FixedScheduler } from './scheduler';
import { migrateRuntime } from './migration';
import { createComputeRuntime } from './compute-runtime';
import { attachStageInput } from './input';
import type { FieldPointer } from './input';
import {
	PARTICLE_BYTES,
	METRIC_BYTES,
	HISTORY_SAMPLES,
	HISTORY_SAMPLE_BYTES,
	packParticles,
	unpackParticles,
	packConfig,
	packSpecies,
	packPairRules,
	gridDefinition,
	historyStride
} from './packing';
import type { Engine, EngineCallbacks, EngineTool } from './contracts';
export type {
	Engine,
	EngineCallbacks,
	EngineTool,
	EngineStats,
	InspectionSample
} from './contracts';

interface Allocations {
	particles: [CoreBuffer, CoreBuffer];
	metrics: [CoreBuffer, CoreBuffer];
	history: CoreBuffer;
	indices: CoreBuffer;
	capacity: number;
}

export async function createEngine(
	canvas: HTMLCanvasElement,
	initialScene: SceneDefinition,
	callbacks: EngineCallbacks = {},
	signal?: AbortSignal
): Promise<Engine> {
	if (signal?.aborted) throw new DOMException('Initialization was canceled.', 'AbortError');
	if (!navigator.gpu)
		throw new Error('WebGPU is unavailable. Open Swarm in a browser with WebGPU support.');
	const scene = assertScene(structuredClone(initialScene));
	const gpu = await init({
		powerPreference: 'high-performance',
		requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxStorageBuffersInVertexStage: 5 }
	});
	const cancel = () => gpu.dispose();
	signal?.addEventListener('abort', cancel, { once: true });
	try {
		if (signal?.aborted) throw new DOMException('Initialization was canceled.', 'AbortError');
		const engine = await mountEngine(gpu, canvas, scene, callbacks);
		if (signal?.aborted) {
			engine.dispose();
			throw new DOMException('Initialization was canceled.', 'AbortError');
		}
		return engine;
	} catch (error) {
		gpu.dispose();
		throw error;
	} finally {
		signal?.removeEventListener('abort', cancel);
	}
}

async function mountEngine(
	gpu: Gpu,
	canvas: HTMLCanvasElement,
	initial: SceneDefinition,
	callbacks: EngineCallbacks
): Promise<Engine> {
	let scene = initial;
	let population = initializePopulation(scene, 1);
	let generation = population.generation;
	let count = population.agents.length;
	let tick = 0,
		simulationTime = 0,
		historyHead = 0,
		validHistory = 1,
		historyTicks = 0,
		lastHistoryTime = 0;
	let particleSide = 0,
		metricSide = 0;
	let disposed = false,
		paused = false,
		busy = false,
		failed = false;
	let raf = 0;
	const initializationErrors: Error[] = [];
	let initializing = true;
	const reportError = (value: unknown) => {
		const error = value instanceof Error ? value : new Error(String(value));
		if (initializing) {
			initializationErrors.push(error);
			return;
		}
		if (disposed || failed) return;
		failed = true;
		cancelAnimationFrame(raf);
		callbacks.onError?.(error);
	};
	const releaseErrors = gpu.onError(reportError);
	const nativeError = (event: GPUUncapturedErrorEvent) => reportError(event.error);
	gpu.gpu.addEventListener('uncapturederror', nativeError);
	let tool: EngineTool = 'look';
	let field: FieldPointer = { active: false, position: [0, 0, 0], pressed: false };
	let selectedId: number | null = null;
	let selectedSlot = -1;
	let selectionIntent = 0;
	let populationVersion = 0;
	let dirty = true,
		pendingScene: SceneDefinition | null = null,
		requestedReset = false;
	let pendingApplication: Promise<void> | null = null;
	let requestedSteps = 0;
	const scheduler = new FixedScheduler();
	const camera = new StageCamera(scene.camera);
	const owned = new Set<CoreBuffer>();
	const allocate = (label: string, size: number) => {
		if (size > gpu.gpu.limits.maxStorageBufferBindingSize)
			throw new Error(
				`${label} needs ${Math.ceil(size / 1048576)} MiB, above this device's buffer limit.`
			);
		const buffer = gpu.device.createBuffer({
			label,
			size: Math.max(16, size),
			usage: ['storage', 'copy_src', 'copy_dst']
		});
		owned.add(buffer);
		return buffer;
	};
	const free = (buffer: CoreBuffer) => {
		owned.delete(buffer);
		buffer.destroy();
	};
	const allocatePopulation = (n: number): Allocations => {
		const capacity = 2 ** Math.ceil(Math.log2(Math.max(128, n)));
		return {
			capacity,
			particles: [
				allocate('agents A', capacity * PARTICLE_BYTES),
				allocate('agents B', capacity * PARTICLE_BYTES)
			],
			metrics: [
				allocate('metrics A', capacity * METRIC_BYTES),
				allocate('metrics B', capacity * METRIC_BYTES)
			],
			history: allocate(
				'world trajectories and historical colors',
				capacity * HISTORY_SAMPLES * HISTORY_SAMPLE_BYTES
			),
			indices: allocate('neighbor index', capacity * 4)
		};
	};
	let buffers = allocatePopulation(count);
	const config = allocate('world configuration', 16384);
	const species = allocate('species configuration', 32 * 64 * 16);
	const pairRules = allocate('directed relationships', 32 * 32 * 16);
	const grid = allocate('complete spatial cells', 65536 * 3 * 4);
	const blocks = allocate('spatial prefix sums', 256 * 4);
	const current = () => buffers.particles[particleSide];
	const currentMetrics = () => buffers.metrics[metricSide];
	let derived = { grid: gridDefinition(scene), stride: historyStride(scene) };
	let configData = new Float32Array((16 + Math.max(1, scene.obstacles.length) * 2) * 4);
	const refreshDerived = () => {
		derived = { grid: gridDefinition(scene), stride: historyStride(scene) };
		configData = new Float32Array((16 + Math.max(1, scene.obstacles.length) * 2) * 4);
	};
	const writeConfig = (smoothingAlpha?: number, sampleHistory = false) =>
		config.write(
			packConfig(
				scene,
				{
					population: count,
					tick,
					simulationTime,
					runGeneration: generation,
					historyHead,
					validHistory,
					historyElapsed: simulationTime - lastHistoryTime,
					sampleHistory,
					historyCapacity: buffers.capacity,
					field,
					smoothingAlpha,
					tool,
					selectedId: selectedId ?? 0
				},
				derived,
				configData
			)
		);
	const writeSpecies = () => {
		if (scene.species.length > 32)
			throw new Error('This laboratory currently supports up to 32 species.');
		if (scene.obstacles.length > 400)
			throw new Error('This laboratory currently supports up to 400 obstacles.');
		if (scene.species.some((s) => s.metricRules.length > 2))
			throw new Error('This laboratory currently evaluates at most two metric rules per species.');
		species.write(packSpecies(scene));
		pairRules.write(packPairRules(scene));
	};
	const initializeBuffers = () => {
		const bytes = packParticles(population.agents, scene, generation, buffers.capacity);
		buffers.particles[0].write(bytes);
		buffers.particles[1].write(bytes);
		const history = new Float32Array(
			(buffers.capacity * HISTORY_SAMPLES * HISTORY_SAMPLE_BYTES) / 4
		);
		population.agents.forEach((agent, i) => {
			for (let j = 0; j < HISTORY_SAMPLES; j++)
				history.set([...agent.position, generation], (i * HISTORY_SAMPLES + j) * 4);
		});
		buffers.history.write(history);
	};
	initializeBuffers();
	writeSpecies();
	writeConfig(1);
	const canvasTarget = surface(gpu, canvas, { dpr: [1, 2], autoResize: true });
	const stageSize = (): [number, number] => {
		const pixelRatio = scene.visual.quality === 'fast' ? 1 : 1.25;
		const scale = scene.visual.quality === 'sharp' ? 1 : Math.min(1, pixelRatio / canvasTarget.dpr);
		return [
			Math.max(1, Math.round(canvasTarget.size[0] * scale)),
			Math.max(1, Math.round(canvasTarget.size[1] * scale))
		];
	};
	const depthTarget = target(gpu, {
		size: stageSize(),
		format: 'rgba16float',
		depth: true,
		label: 'depth-tested swarm'
	});
	const glowSize = (): [number, number] => [
		Math.max(1, Math.ceil(depthTarget.size[0] / 4)),
		Math.max(1, Math.ceil(depthTarget.size[1] / 4))
	];
	const brightTarget = target(gpu, {
		size: glowSize(),
		format: 'rgba16float',
		label: 'downsampled highlights'
	});
	const glowTarget = target(gpu, { size: glowSize(), format: 'rgba16float', label: 'soft glow' });
	const computeBuffers = () => ({ ...buffers, config, grid, blocks, species, pairRules });
	const simulation = await createComputeRuntime(
		gpu,
		{
			grid: gridShader,
			simulation: simulationShader,
			metrics: metricsShader,
			history: historyShader
		},
		computeBuffers()
	);
	const cameraUniform = () => ({
		viewProjection: camera.camera.viewProjection,
		position: [...camera.position, 1],
		right: [...camera.right, 0],
		up: [...camera.up, 0]
	});
	const sharedCamera = uniforms(gpu, cameraUniform());
	const bodies = draw(gpu, {
		shader: boidShader,
		vertices: 36,
		depth: { write: true, compare: 'less-equal' },
		label: 'oriented agents'
	});
	const trails = draw(gpu, {
		shader: trailShader,
		vertices: 6 * (HISTORY_SAMPLES - 1),
		depth: { write: false, compare: 'less-equal' },
		blend: 'premultiplied',
		label: 'world-space wakes'
	});
	const world = draw(gpu, {
		shader: worldShader,
		vertices: 14400,
		depth: { write: false, compare: 'less-equal' },
		blend: 'alpha',
		label: 'world geometry'
	});
	const shell = draw(gpu, {
		shader: worldShader,
		vertices: 10800,
		entry: { vertex: 'vs_shell', fragment: 'fs_shell' },
		writeMask: [],
		depth: { write: true, compare: 'less-equal' },
		label: 'surface occlusion'
	});
	const obstacles = draw(gpu, {
		shader: worldShader,
		vertices: 10800,
		entry: { vertex: 'vs_obstacles', fragment: 'fs_obstacles' },
		depth: { write: true, compare: 'less-equal' },
		label: 'physical obstacles'
	});
	const forceIndicator = draw(gpu, {
		shader: worldShader,
		vertices: 1536,
		entry: { vertex: 'vs_force', fragment: 'fs_force' },
		depth: { write: false, compare: 'less-equal' },
		blend: 'premultiplied',
		label: 'world-space field radius'
	});
	const workPlane = draw(gpu, {
		shader: worldShader,
		vertices: 492,
		entry: { vertex: 'vs_plane', fragment: 'fs_plane' },
		depth: { write: false, compare: 'less-equal' },
		blend: 'premultiplied',
		label: 'visible placement plane'
	});
	const linearSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
	const extractGlow = effect(gpu, highlightShader, {
		set: { image: depthTarget, imageSampler: linearSampler, glow: { texel: depthTarget.texelSize } }
	});
	const blurGlow = effect(gpu, bloomShader, {
		set: {
			image: brightTarget,
			imageSampler: linearSampler,
			glow: { texel: brightTarget.texelSize }
		}
	});
	const present = effect(gpu, presentationShader, {
		set: {
			image: depthTarget,
			imageSampler: linearSampler,
			glow: glowTarget,
			presentation: {
				bloom: Number(scene.visual.bloom),
				exposure: scene.visual.exposure
			}
		}
	});
	function bind() {
		bodies.set({
			config,
			particles: current(),
			metrics: currentMetrics(),
			species,
			camera: sharedCamera
		});
		trails.set({
			config,
			particles: current(),
			metrics: currentMetrics(),
			species,
			history: buffers.history,
			camera: sharedCamera
		});
		world.set({ config, camera: sharedCamera });
		shell.set({ config, camera: sharedCamera });
		obstacles.set({ config, camera: sharedCamera });
		forceIndicator.set({ config, camera: sharedCamera });
		workPlane.set({ config, camera: sharedCamera });
	}
	function bootstrap(alpha = 1, sampleHistory = alpha > 0) {
		writeConfig(alpha, sampleHistory);
		simulation.rebind(computeBuffers());
		simulation.bootstrap(particleSide, metricSide, count, derived.grid.count);
		metricSide = 1 - metricSide;
		bind();
	}
	bootstrap();
	await Promise.all([
		bodies.compile(depthTarget),
		trails.compile(depthTarget),
		world.compile(depthTarget),
		shell.compile(depthTarget),
		obstacles.compile(depthTarget),
		forceIndicator.compile(depthTarget),
		workPlane.compile(depthTarget),
		extractGlow.compile(brightTarget),
		blurGlow.compile(glowTarget),
		present.compile({ colors: [canvasTarget.format] })
	]);
	await gpu.settled();
	if (initializationErrors.length) {
		releaseErrors();
		gpu.gpu.removeEventListener('uncapturederror', nativeError);
		throw initializationErrors[0];
	}
	initializing = false;
	let inFlight = 0,
		lastTime = performance.now(),
		statsTime = lastTime,
		frames = 0,
		statsSeconds = 0,
		lastInspect = 0;
	let inspectionPending = false;
	const adapter = (gpu.gpu as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo;
	const adapterName = adapter?.description || adapter?.device || 'WebGPU';
	void gpu.gpu.lost.then((info) => {
		if (!disposed)
			reportError(
				new Error(
					`The graphics device was lost: ${info.message || info.reason}. Retry to start a new run.`
				)
			);
	});
	const resize = canvasTarget.onResize(() => {
		resizeStage();
		camera.update(canvasTarget.size[0] / canvasTarget.size[1]);
		dirty = true;
	});
	function resizeStage() {
		depthTarget.resize(stageSize());
		brightTarget.resize(glowSize());
		glowTarget.resize(glowSize());
		extractGlow.set({ glow: { texel: depthTarget.texelSize } });
		blurGlow.set({ glow: { texel: brightTarget.texelSize } });
	}
	camera.update(canvasTarget.size[0] / canvasTarget.size[1]);
	const releaseInput = attachStageInput(canvas, camera, {
		getScene: () => scene,
		getTool: () => tool,
		onField(value) {
			field = value;
			dirty = true;
		},
		onInspect(x, y) {
			void selectAt(x, y).catch(reportError);
		},
		onObstacle(position, normal, drag) {
			callbacks.onObstacle?.(position, normal, drag);
		},
		onChange() {
			dirty = true;
		}
	});
	const visibility = () => {
		scheduler.reset();
		lastTime = performance.now();
		field = { ...field, active: false, pressed: false };
	};
	document.addEventListener('visibilitychange', visibility);
	function physicsTick() {
		tick++;
		simulationTime += scene.dynamics.fixedDt;
		const sampleHistory = ++historyTicks >= derived.stride;
		if (sampleHistory) {
			historyHead = (historyHead + 1) % HISTORY_SAMPLES;
			validHistory = Math.min(HISTORY_SAMPLES, validHistory + 1);
			historyTicks = 0;
			lastHistoryTime = simulationTime;
		}
		writeConfig(undefined, sampleHistory);
		simulation.tick(particleSide, metricSide, count, derived.grid.count, sampleHistory);
		particleSide = 1 - particleSide;
		metricSide = 1 - metricSide;
		statsSeconds += scene.dynamics.fixedDt;
		dirty = true;
	}
	function render() {
		writeConfig();
		bodies.set({ particles: current(), metrics: currentMetrics() });
		trails.set({ particles: current(), metrics: currentMetrics() });
		present.set({
			presentation: {
				bloom: Number(scene.visual.bloom),
				exposure: scene.visual.exposure
			}
		});
		const bg = scene.visual.background.match(/[a-f\d]{2}/gi)?.map((v) => {
			const value = parseInt(v, 16) / 255;
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		}) ?? [0.0006, 0.0009, 0.0015];
		const activeTrailSeconds = Math.max(
			0,
			...scene.species
				.filter((s) => s.population > 0 && s.trail.opacity > 0 && s.trail.width > 0)
				.map((s) => s.trail.length)
		);
		const sampleSeconds = derived.stride * scene.dynamics.fixedDt;
		const headSeconds = simulationTime - lastHistoryTime;
		const trailSegments =
			activeTrailSeconds > 0
				? Math.min(
						HISTORY_SAMPLES - 1,
						validHistory,
						1 + Math.max(0, Math.ceil((activeTrailSeconds - headSeconds) / sampleSeconds))
					)
				: 0;
		const submitted = frame(gpu, (f) => {
			// Surface auto-resize runs when the frame opens, before this callback.
			sharedCamera.set(cameraUniform());
			f.pass({ target: depthTarget, clear: [bg[0], bg[1], bg[2], 1], clearDepth: 1 }, (p) => {
				if (scene.world.kind === 'surface')
					p.draw(shell, {
						vertices:
							scene.world.shape === 'plane' ? 6 : scene.world.shape === 'torus' ? 55296 : 10800
					});
				if (scene.obstacleSettings.enabled && scene.obstacles.length)
					p.draw(obstacles, { instances: scene.obstacles.length });
				if (scene.visual.showBoundary)
					p.draw(world, {
						vertices: { box: 72, sphere: 4464, plane: 132, cylinder: 2928, torus: 4608 }[
							scene.world.shape
						]
					});
				if (scene.world.kind === 'volume' && (tool === 'force' || tool === 'obstacle'))
					p.draw(workPlane);
				if (trailSegments > 0) p.draw(trails, { instances: count, vertices: trailSegments * 6 });
				p.draw(bodies, { instances: count });
				if (tool === 'force' && field.active) p.draw(forceIndicator);
			});
			if (scene.visual.bloom) {
				f.pass(brightTarget, extractGlow);
				f.pass(glowTarget, blurGlow);
			}
			f.pass(canvasTarget, present);
		});
		inFlight++;
		// frame.done settles validation and pipeline delivery, not hardware execution.
		// Bound actual queue work so a slow device cannot accumulate minutes of ticks.
		void Promise.all([submitted.done, gpu.gpu.queue.onSubmittedWorkDone()]).then(
			() => {
				inFlight--;
			},
			(error) => {
				inFlight--;
				reportError(error);
			}
		);
		frames++;
		dirty = false;
	}
	async function inspect() {
		if (selectedSlot < 0 || inspectionPending || disposed) return;
		inspectionPending = true;
		const run = generation,
			intent = selectionIntent,
			id = selectedId,
			slot = selectedSlot,
			time = tick,
			elapsed = simulationTime,
			version = populationVersion;
		const sampledScene = scene;
		try {
			const [particle, metrics] = await Promise.all([
				current().read(PARTICLE_BYTES, slot * PARTICLE_BYTES),
				currentMetrics().read(METRIC_BYTES, slot * METRIC_BYTES)
			]);
			if (
				disposed ||
				selectionIntent !== intent ||
				generation !== run ||
				selectedId !== id ||
				populationVersion !== version
			)
				return;
			const values = new Float32Array(particle),
				identity = new Uint32Array(particle),
				m = new Float32Array(metrics);
			if (identity[12] !== id) return;
			callbacks.onInspect?.({
				id: id!,
				speciesKey: sampledScene.species[identity[13]].key,
				position: [values[0], values[1], values[2]],
				velocity: [values[4], values[5], values[6]],
				speed: m[0],
				turnRate: m[1],
				acceleration: m[2],
				neighbors: m[3],
				density: m[4],
				structure: m[5],
				simulationTime: elapsed,
				tick: time
			});
		} finally {
			inspectionPending = false;
		}
	}
	async function selectAt(clientX: number, clientY: number) {
		if (busy || disposed) return;
		const run = generation,
			intent = ++selectionIntent,
			version = populationVersion;
		// Full readback is confined to an explicit pick; ongoing inspection reads one agent.
		const bytes = await current().read(count * PARTICLE_BYTES);
		if (
			disposed ||
			selectionIntent !== intent ||
			generation !== run ||
			version !== populationVersion
		)
			return;
		const f = new Float32Array(bytes),
			u = new Uint32Array(bytes),
			bounds = canvas.getBoundingClientRect();
		let best = Infinity,
			slot = -1;
		for (let i = 0; i < count; i++) {
			const pos: Vec3 = [f[i * 16], f[i * 16 + 1], f[i * 16 + 2]];
			const normal = worldNormal(scene.world, pos);
			if (
				scene.world.kind === 'surface' &&
				normal[0] * (camera.position[0] - pos[0]) +
					normal[1] * (camera.position[1] - pos[1]) +
					normal[2] * (camera.position[2] - pos[2]) <
					0
			)
				continue;
			const p = camera.project(pos);
			if (p[2] < 0 || p[2] > 1) continue;
			const dx = (p[0] * 0.5 + 0.5) * bounds.width + bounds.left - clientX,
				dy = (0.5 - p[1] * 0.5) * bounds.height + bounds.top - clientY;
			const dist = dx * dx + dy * dy;
			if (dist >= 24 ** 2) continue;
			if (scene.world.shape === 'torus') {
				// A front-facing point on the inner tube can still be hidden by the
				// nearer outer tube. Only candidates near the click need this query.
				const toward: Vec3 = [
					pos[0] - camera.position[0],
					pos[1] - camera.position[1],
					pos[2] - camera.position[2]
				];
				const hit = pickWorldRay(scene.world, camera.position, toward);
				const bodyRadius = scene.species[u[i * 16 + 13]].size;
				if (
					hit &&
					Math.hypot(...toward) -
						Math.hypot(
							hit.position[0] - camera.position[0],
							hit.position[1] - camera.position[1],
							hit.position[2] - camera.position[2]
						) >
						bodyRadius * 2
				)
					continue;
			}
			const score = dist + p[2] * 0.1;
			if (dist < 24 ** 2 && score < best) {
				best = score;
				slot = i;
			}
		}
		selectedSlot = slot;
		selectedId = slot < 0 ? null : u[slot * 16 + 12];
		dirty = true;
		if (slot < 0) callbacks.onInspect?.(null);
		else await inspect();
	}
	async function applyPending() {
		if (!pendingScene && !requestedReset) return;
		busy = true;
		const nextScene = pendingScene ?? scene;
		pendingScene = null;
		const reset =
			requestedReset ||
			JSON.stringify(nextScene.world) !== JSON.stringify(scene.world) ||
			nextScene.seed !== scene.seed;
		requestedReset = false;
		try {
			const oldScene = scene,
				oldPopulation = population,
				oldCount = count;
			const qualityChanged = scene.visual.quality !== nextScene.visual.quality;
			const changedPopulation =
				reset ||
				JSON.stringify(scene.species.map((s) => [s.key, s.population])) !==
					JSON.stringify(nextScene.species.map((s) => [s.key, s.population]));
			const changedStride =
				historyStride(scene) !== historyStride(nextScene) ||
				scene.dynamics.fixedDt !== nextScene.dynamics.fixedDt;
			if (changedPopulation || changedStride) {
				populationVersion++;
				const oldBuffers = buffers;
				const [particlesBytes, historyBytes, metricsBytes] = reset
					? [null, null, null]
					: await Promise.all([
							current().read(count * PARTICLE_BYTES),
							buffers.history.read(buffers.capacity * HISTORY_SAMPLES * HISTORY_SAMPLE_BYTES),
							currentMetrics().read(count * METRIC_BYTES)
						]);
				if (disposed) return;
				if (particlesBytes)
					population = {
						...oldPopulation,
						agents: unpackParticles(particlesBytes, oldScene, oldCount)
					};
				scene = nextScene;
				refreshDerived();
				population = reset
					? initializePopulation(scene, ++generation)
					: reconcilePopulation(population, scene);
				count = population.agents.length;
				if (count > buffers.capacity) buffers = allocatePopulation(count);
				particleSide = 0;
				metricSide = 0;
				initializeBuffers();
				if (historyBytes && !reset) {
					const oldStride = historyStride(oldScene) * oldScene.dynamics.fixedDt,
						newStride = historyStride(scene) * scene.dynamics.fixedDt;
					const migrated = migrateRuntime(population.agents, scene, generation, buffers.capacity, {
						particles: particlesBytes!,
						metrics: metricsBytes!,
						history: historyBytes,
						head: historyHead,
						valid: validHistory,
						oldInterval: oldStride,
						newInterval: newStride,
						headElapsed: simulationTime - lastHistoryTime
					});
					for (const buffer of buffers.particles) buffer.write(migrated.particles);
					for (const buffer of buffers.metrics) buffer.write(migrated.metrics);
					buffers.history.write(migrated.history);
					validHistory = migrated.valid;
				} else {
					tick = 0;
					simulationTime = 0;
					historyHead = 0;
					validHistory = 1;
				}
				lastHistoryTime = simulationTime;
				historyTicks = 0;
				if (buffers !== oldBuffers) {
					await gpu.gpu.queue.onSubmittedWorkDone();
					if (disposed) return;
					for (const buffer of [
						...oldBuffers.particles,
						...oldBuffers.metrics,
						oldBuffers.history,
						oldBuffers.indices
					])
						free(buffer);
				}
				if (reset) {
					requestedSteps = 0;
					selectedId = null;
					selectedSlot = -1;
					callbacks.onInspect?.(null);
					camera.definition = structuredClone(scene.camera);
				} else {
					selectedSlot = population.agents.findIndex((a) => a.id === selectedId);
					if (selectedSlot < 0) {
						selectedId = null;
						callbacks.onInspect?.(null);
					}
				}
				writeSpecies();
				bootstrap(reset ? 1 : 0, true);
			} else {
				const queryChanged =
					JSON.stringify(gridDefinition(scene)) !== JSON.stringify(gridDefinition(nextScene)) ||
					scene.species.some((s, i) => s.perception !== nextScene.species[i].perception);
				scene = nextScene;
				refreshDerived();
				writeSpecies();
				writeConfig();
				if (queryChanged) {
					bootstrap(0);
				}
			}
			if (qualityChanged) resizeStage();
			scheduler.reset();
			lastTime = performance.now();
			dirty = true;
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}
	function animate(now: number) {
		if (disposed || failed) return;
		raf = requestAnimationFrame(animate);
		if (document.hidden) {
			lastTime = now;
			scheduler.reset();
			return;
		}
		const elapsed = Math.max(0, (now - lastTime) / 1000);
		lastTime = now;
		if (busy) return;
		if (pendingScene || requestedReset) {
			pendingApplication = applyPending().finally(() => {
				pendingApplication = null;
			});
			return;
		}
		try {
			camera.update(canvasTarget.size[0] / canvasTarget.size[1], elapsed);
			if (camera.definition.autoRotate !== 0) dirty = true;
			if (!paused) {
				scheduler.record(
					elapsed,
					scene.dynamics.fixedDt,
					scene.dynamics.maxSubsteps,
					scene.dynamics.timeScale
				);
			}
			if (inFlight < 2) {
				if (!paused) {
					const steps = scheduler.take(scene.dynamics.fixedDt, scene.dynamics.maxSubsteps);
					for (let i = 0; i < steps; i++) physicsTick();
				} else {
					const steps = Math.min(requestedSteps, scene.dynamics.maxSubsteps);
					for (let i = 0; i < steps; i++) physicsTick();
					requestedSteps -= steps;
				}
				if (dirty) render();
				if (now - lastInspect > 200) {
					lastInspect = now;
					void inspect().catch(reportError);
				}
			}
			if (now - statsTime > 500) {
				const duration = (now - statsTime) / 1000;
				callbacks.onStats?.({
					fps: frames / duration,
					simulationTime,
					tick,
					population: count,
					realTimeFactor: paused ? 0 : statsSeconds / duration,
					trailBytes: buffers.capacity * HISTORY_SAMPLES * HISTORY_SAMPLE_BYTES,
					adapter: adapterName
				});
				frames = 0;
				statsSeconds = 0;
				statsTime = now;
			}
		} catch (error) {
			reportError(error);
		}
	}
	raf = requestAnimationFrame(animate);
	callbacks.onReady?.();
	return {
		updateScene(value) {
			pendingScene = assertScene(structuredClone(value));
			if (
				pendingScene.seed !== scene.seed ||
				JSON.stringify(pendingScene.world) !== JSON.stringify(scene.world)
			)
				selectionIntent++;
		},
		reset(value) {
			if (value) pendingScene = assertScene(structuredClone(value));
			selectionIntent++;
			requestedReset = true;
		},
		setPaused(value) {
			paused = value;
			scheduler.reset();
			lastTime = performance.now();
			dirty = true;
		},
		step() {
			if (paused && !disposed && !failed) requestedSteps++;
		},
		setTool(value) {
			tool = value;
			field = { ...field, active: false, pressed: false };
			dirty = true;
		},
		selectAt,
		clearSelection() {
			selectionIntent++;
			selectedId = null;
			selectedSlot = -1;
			dirty = true;
			callbacks.onInspect?.(null);
		},
		getCamera() {
			return structuredClone(camera.definition);
		},
		setCamera(value) {
			camera.definition = structuredClone(value);
			dirty = true;
		},
		resetCamera() {
			camera.definition = structuredClone((pendingScene ?? scene).camera);
			dirty = true;
		},
		fitCamera() {
			// A world edit commits at the next tick boundary. Fit that pending world
			// now, and retain its fitted framing when the reset restores the camera.
			const fitScene = pendingScene ?? scene;
			const willReset =
				requestedReset ||
				JSON.stringify(fitScene.world) !== JSON.stringify(scene.world) ||
				fitScene.seed !== scene.seed;
			if (willReset) camera.definition = structuredClone(fitScene.camera);
			const radius =
				fitScene.world.shape === 'sphere'
					? fitScene.world.radius
					: fitScene.world.shape === 'cylinder'
						? Math.hypot(fitScene.world.radius, fitScene.world.halfHeight)
						: fitScene.world.shape === 'torus'
							? fitScene.world.majorRadius + fitScene.world.tubeRadius
							: Math.hypot(...worldBounds(fitScene.world));
			const vertical = (Math.PI * 21) / 180;
			const angle = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
			camera.definition.target = [0, 0, 0];
			camera.definition.distance =
				((radius + Math.max(...fitScene.species.map((s) => s.size)) * 2) / Math.sin(angle)) * 1.05;
			if (pendingScene && willReset) pendingScene.camera = structuredClone(camera.definition);
			dirty = true;
		},
		setAutoRotate(value) {
			camera.definition.autoRotate = value ? 0.08 : 0;
			dirty = true;
		},
		async screenshot() {
			while (pendingApplication || pendingScene || requestedReset) {
				if (!pendingApplication)
					pendingApplication = applyPending().finally(() => {
						pendingApplication = null;
					});
				await pendingApplication;
			}
			if (disposed || failed) throw new Error('The GPU world is unavailable for capture.');
			render();
			await gpu.gpu.queue.onSubmittedWorkDone();
			return await new Promise<Blob>((resolve, reject) =>
				canvas.toBlob(
					(blob) => (blob ? resolve(blob) : reject(new Error('Unable to capture the stage.'))),
					'image/png'
				)
			);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelAnimationFrame(raf);
			releaseInput();
			resize();
			releaseErrors();
			document.removeEventListener('visibilitychange', visibility);
			gpu.gpu.removeEventListener('uncapturederror', nativeError);
			for (const buffer of owned) buffer.destroy();
			owned.clear();
			gpu.dispose();
		}
	};
}
