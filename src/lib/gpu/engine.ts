import { init, draw, effect, frame, sampler, surface, target, uniforms } from 'vgpu';
import type { Gpu } from 'vgpu';
import type { Buffer as CoreBuffer } from 'vgpu/core';
import {
	reconcilePopulation,
	assertScene,
	worldBounds,
	isTopologyWorld,
	isSmoothTopologyWorld,
	smoothTopologyTriangle,
	topologyMesh,
	worldDefaultCamera
} from '#lib/model';
import type { SceneDefinition, Vec3 } from '#lib/model';
import gridShader from './shaders/grid.wgsl';
import simulationShader from './shaders/simulate.wgsl';
import metricsShader from './shaders/metrics.wgsl';
import historyShader from './shaders/history.wgsl';
import boidShader from './shaders/boids.wgsl';
import trailShader from './shaders/trails.wgsl';
import worldShader from './shaders/world.wgsl';
import forceShader from './shaders/force.wgsl';
import bloomShader from './shaders/bloom.wgsl';
import highlightShader from './shaders/highlights.wgsl';
import presentationShader from './shaders/presentation.wgsl';
import { pickWorldRay, StageCamera } from './camera';
import { agentRenderCenter } from './surface-render';
import { FixedScheduler } from './scheduler';
import { trailQuadIndices, trailSegmentCount, trailSpeciesRanges } from './trail-render';
import { createTopologyPreparer } from './topology';
import type { TopologyPreparer, PreparedTopology } from './topology';
import { requiredMetricMask } from './metric-demand';
import { createComputeRuntime } from './compute-runtime';
import { attachStageInput } from './input';
import { forceVisualStyle } from './force-visual';
import { linearBackground } from './appearance';
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
	const preparer = createTopologyPreparer();
	const cancel = () => {
		preparer.dispose();
		gpu.dispose();
	};
	signal?.addEventListener('abort', cancel, { once: true });
	try {
		if (signal?.aborted) throw new DOMException('Initialization was canceled.', 'AbortError');
		const engine = await mountEngine(gpu, canvas, scene, callbacks, preparer);
		if (signal?.aborted) {
			engine.dispose();
			throw new DOMException('Initialization was canceled.', 'AbortError');
		}
		return engine;
	} catch (error) {
		preparer.dispose();
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
	callbacks: EngineCallbacks,
	preparer: TopologyPreparer
): Promise<Engine> {
	let scene = initial;
	const capacityFor = (value: SceneDefinition) =>
		2 **
		Math.ceil(
			Math.log2(
				Math.max(
					128,
					value.species.reduce((n, s) => n + s.population, 0)
				)
			)
		);
	const initialPreparation = await preparer.prepare(scene, {
		generation: 1,
		capacity: capacityFor(scene)
	});
	let population = initialPreparation.population!;
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
	let sceneRevision = 0;
	let cameraRevision = 0,
		requestedCameraRevision = 0;
	let pendingPreparation: { revision: number; promise: Promise<PreparedTopology> } | null = null;
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
	let configData = packConfig(
		scene,
		{ population: count, tick, historyHead, validHistory },
		undefined,
		undefined,
		initialPreparation.topology
	);
	let config = allocate('world configuration', Math.max(16384, configData.byteLength));
	const species = allocate('species configuration', 32 * 64 * 16);
	const pairRules = allocate('directed relationships', 32 * 32 * 16);
	const grid = allocate('complete spatial cells', (65536 * 3 + 1) * 4);
	const blocks = allocate('spatial prefix sums', 256 * 4);
	const current = () => buffers.particles[particleSide];
	const currentMetrics = () => buffers.metrics[metricSide];
	let derived = { grid: gridDefinition(scene), stride: historyStride(scene) };
	let trailRanges = trailSpeciesRanges(scene);
	let metricMask = requiredMetricMask(scene);
	let configGeometry = `${JSON.stringify(scene.world)}:${scene.obstacles.length}`;
	const refreshDerived = (preparedTopology?: Float32Array<ArrayBuffer>) => {
		derived = { grid: gridDefinition(scene), stride: historyStride(scene) };
		trailRanges = trailSpeciesRanges(scene);
		metricMask = requiredMetricMask(scene);
		const geometry = `${JSON.stringify(scene.world)}:${scene.obstacles.length}`;
		if (geometry !== configGeometry) {
			configGeometry = geometry;
			configData = packConfig(
				scene,
				{ population: count, tick, historyHead, validHistory },
				undefined,
				undefined,
				preparedTopology
			);
			if (configData.byteLength > config.options.size) {
				const old = config;
				config = allocate('world configuration', configData.byteLength);
				void gpu.gpu.queue.onSubmittedWorkDone().then(() => {
					if (!disposed) free(old);
				}, reportError);
			}
			config.write(configData);
			simulation.rebind(computeBuffers());
			bind();
		}
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
					metricMask,
					selectedId: selectedId ?? 0
				},
				derived,
				configData
			).subarray(0, (16 + scene.obstacles.length * 2) * 4)
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
	const initializeBuffers = (preparedParticles?: ArrayBuffer) => {
		const bytes =
			preparedParticles ?? packParticles(population.agents, scene, generation, buffers.capacity);
		buffers.particles[0].write(bytes);
		buffers.particles[1].write(bytes);
		// Bootstrap writes the first authoritative position/color sample on the GPU.
		// validHistory hides the other slots until subsequent physical ticks fill them.
	};
	initializeBuffers(initialPreparation.particles);
	writeSpecies();
	config.write(configData);
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
		viewProjection: camera.viewProjection,
		position: [...camera.position, 1],
		right: [...camera.right, depthTarget.size[0] / depthTarget.size[1]],
		up: [...camera.up, depthTarget.size[1]]
	});
	const sharedCamera = uniforms(gpu, cameraUniform());
	const bodies = draw(gpu, {
		shader: boidShader,
		vertices: 36,
		depth: { write: true, compare: 'less-equal' },
		label: 'oriented agents'
	});
	const trailIndexPattern = trailQuadIndices();
	const trailIndices = gpu.device.createBuffer({
		label: 'shared world-space trail quad indices',
		size: trailIndexPattern.byteLength,
		usage: ['index', 'copy_dst']
	});
	owned.add(trailIndices);
	trailIndices.write(trailIndexPattern);
	const trails = draw(gpu, {
		shader: trailShader,
		entry: { vertex: 'vs_indexed', fragment: 'fs_main' },
		geometry: {
			indexBuffer: trailIndices.gpu,
			indexFormat: 'uint16',
			indexCount: trailIndexPattern.length
		},
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
	const fieldStyle = uniforms(gpu, forceVisualStyle(scene));
	const forceIndicator = draw(gpu, {
		shader: forceShader,
		vertices: 2160,
		depth: { write: false, compare: 'less-equal' },
		blend: 'premultiplied',
		label: 'world-space field radius'
	});
	const workPlane = draw(gpu, {
		shader: worldShader,
		vertices: 132,
		entry: { vertex: 'vs_plane', fragment: 'fs_plane' },
		depth: { write: false, compare: 'less-equal' },
		blend: 'premultiplied',
		label: 'visible placement plane'
	});
	const linearSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
	const extractGlow = effect(gpu, highlightShader, {
		set: {
			image: depthTarget,
			imageSampler: linearSampler,
			glow: {
				texel: depthTarget.texelSize,
				background: linearBackground(scene.visual),
				day: Number(scene.visual.theme === 'day')
			}
		}
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
				exposure: scene.visual.exposure,
				day: Number(scene.visual.theme === 'day')
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
		forceIndicator.set({ config, camera: sharedCamera, fieldStyle });
		workPlane.set({ config, camera: sharedCamera });
	}
	function bootstrap(alpha = 1, sampleHistory = alpha > 0) {
		writeConfig(alpha, sampleHistory);
		simulation.rebind(computeBuffers());
		simulation.bootstrap(
			particleSide,
			metricSide,
			count,
			derived.grid.count,
			metricMask,
			selectedId ?? 0
		);
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
		extractGlow.set({
			glow: {
				texel: depthTarget.texelSize,
				background: linearBackground(scene.visual),
				day: Number(scene.visual.theme === 'day')
			}
		});
		blurGlow.set({ glow: { texel: brightTarget.texelSize } });
	}
	camera.update(canvasTarget.size[0] / canvasTarget.size[1]);
	const stageInput = attachStageInput(canvas, camera, {
		getScene: () => scene,
		getTool: () => tool,
		onField(value) {
			field = value;
			dirty = true;
		},
		onInspect(x, y) {
			void selectAt(x, y).catch(reportError);
		},
		onObstacle(position, normal, drag, triangle) {
			callbacks.onObstacle?.(position, normal, drag, triangle);
		},
		onChange() {
			cameraRevision++;
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
		simulation.tick(
			particleSide,
			metricSide,
			count,
			derived.grid.count,
			sampleHistory,
			metricMask,
			selectedId ?? 0,
			configData[2]
		);
		particleSide = 1 - particleSide;
		metricSide = 1 - metricSide;
		statsSeconds += scene.dynamics.fixedDt;
		dirty = true;
	}
	function render() {
		writeConfig();
		if (tool === 'force' && field.active) {
			const style = forceVisualStyle(scene);
			style.intent[2] = Number(field.pressed);
			style.intent[3] = depthTarget.size[1];
			fieldStyle.set(style);
		}
		bodies.set({ particles: current(), metrics: currentMetrics() });
		trails.set({ particles: current(), metrics: currentMetrics() });
		present.set({
			presentation: {
				bloom: Number(scene.visual.bloom),
				exposure: scene.visual.exposure,
				day: Number(scene.visual.theme === 'day')
			}
		});
		const bg = linearBackground(scene.visual);
		extractGlow.set({
			glow: {
				texel: depthTarget.texelSize,
				background: bg,
				day: Number(scene.visual.theme === 'day')
			}
		});
		const sampleSeconds = derived.stride * scene.dynamics.fixedDt;
		const headSeconds = simulationTime - lastHistoryTime;
		const submitted = frame(gpu, (f) => {
			// Surface auto-resize runs when the frame opens, before this callback.
			sharedCamera.set(cameraUniform());
			f.pass({ target: depthTarget, clear: [bg[0], bg[1], bg[2], 1], clearDepth: 1 }, (p) => {
				if (scene.world.kind === 'surface')
					p.draw(shell, {
						vertices: isTopologyWorld(scene.world)
							? topologyMesh(scene.world).triangles.length * 3
							: scene.world.shape === 'plane'
								? 6
								: scene.world.shape === 'torus'
									? 55296
									: 10800
					});
				if (scene.obstacleSettings.enabled && scene.obstacles.length)
					p.draw(obstacles, { instances: scene.obstacles.length });
				if (scene.visual.showBoundary || scene.visual.showGrid)
					p.draw(world, {
						vertices: isTopologyWorld(scene.world)
							? topologyMesh(scene.world).triangles.length * 54
							: { box: 270, sphere: 6192, plane: 156, cylinder: 2952, torus: 6912 }[
									scene.world.shape
								]
					});
				if (scene.world.kind === 'volume' && (tool === 'force' || tool === 'obstacle'))
					p.draw(workPlane);
				for (const range of trailRanges) {
					const definition = scene.species.find((species) => species.key === range.key)!;
					const trailSegments = trailSegmentCount(
						definition.trail.opacity > 0 && definition.trail.width > 0
							? definition.trail.length
							: 0,
						sampleSeconds,
						headSeconds,
						validHistory
					);
					if (range.instances > 0 && trailSegments > 0)
						p.draw(trails, {
							instances: range.instances,
							firstInstance: range.firstInstance,
							indices: trailSegments * 6
						});
				}
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
				...(isTopologyWorld(sampledScene.world)
					? {
							triangle: isSmoothTopologyWorld(sampledScene.world)
								? smoothTopologyTriangle(sampledScene.world, [values[3], values[11]])
								: Math.round(values[3]) - 1,
							orientation: (values[7] < 0 ? -1 : 1) as 1 | -1
						}
					: {}),
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
			const bodyRadius = scene.species[u[i * 16 + 13]].size;
			const center = agentRenderCenter(
				scene.world,
				pos,
				bodyRadius,
				camera.position,
				isSmoothTopologyWorld(scene.world)
					? smoothTopologyTriangle(scene.world, [f[i * 16 + 3], f[i * 16 + 11]])
					: isTopologyWorld(scene.world)
						? Math.round(f[i * 16 + 3]) - 1
						: undefined,
				isSmoothTopologyWorld(scene.world) ? [f[i * 16 + 3], f[i * 16 + 11]] : undefined
			);
			const p = camera.project(center);
			if (p[2] < 0 || p[2] > 1) continue;
			const dx = (p[0] * 0.5 + 0.5) * bounds.width + bounds.left - clientX,
				dy = (0.5 - p[1] * 0.5) * bounds.height + bounds.top - clientY;
			const dist = dx * dx + dy * dy;
			if (dist >= 24 ** 2) continue;
			if (scene.world.kind === 'surface' && scene.world.shape !== 'plane') {
				// Any curved surface can hide a farther candidate. The same physical
				// ray test works from outside or inside the shell, including torus tubes.
				const toward: Vec3 = [
					center[0] - camera.position[0],
					center[1] - camera.position[1],
					center[2] - camera.position[2]
				];
				const hit = pickWorldRay(scene.world, camera.position, toward);
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
		else {
			// Initialize newly requested inspection fields without a physical tick or
			// a second temporal-filter update, including while paused.
			bootstrap(0);
			await inspect();
		}
	}
	const needsReset = (value: SceneDefinition) =>
		requestedReset ||
		JSON.stringify(value.world) !== JSON.stringify(scene.world) ||
		value.seed !== scene.seed;
	function queuePreparation() {
		sceneRevision++;
		requestedCameraRevision = cameraRevision;
		const value = pendingScene ?? scene;
		const reset = needsReset(value);
		const geometryChanged =
			`${JSON.stringify(value.world)}:${value.obstacles.length}` !== configGeometry;
		pendingPreparation =
			reset || geometryChanged
				? {
						revision: sceneRevision,
						promise: preparer.prepare(
							value,
							reset
								? {
										generation: generation + 1,
										capacity: Math.max(buffers.capacity, capacityFor(value))
									}
								: undefined
						)
					}
				: null;
		// Superseded callers may not reach applyPending before their worker request
		// is rejected. Attach a handler now; the active commit still reports failures.
		void pendingPreparation?.promise.catch(() => {});
		if (!busy) pendingApplication = null;
	}
	function startPendingApplication() {
		const application = applyPending().finally(() => {
			if (pendingApplication === application) pendingApplication = null;
		});
		pendingApplication = application;
		return application;
	}
	async function applyPending() {
		if (!pendingScene && !requestedReset) return;
		const revision = sceneRevision;
		const cameraAtRequest = requestedCameraRevision;
		const nextScene = pendingScene ?? scene;
		const reset = needsReset(nextScene);
		let committing = false;
		try {
			// Expensive atlas construction and seeded initialization happen off-thread.
			// Until ready, every frame continues using the completed old world.
			const prepared =
				pendingPreparation?.revision === revision ? await pendingPreparation.promise : undefined;
			if (disposed || failed || revision !== sceneRevision) return;
			pendingScene = null;
			requestedReset = false;
			pendingPreparation = null;
			busy = committing = true;
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
				if (disposed || failed) return;
				const nextPopulation = reset
					? prepared!.population!
					: reconcilePopulation(
							{
								...oldPopulation,
								agents: unpackParticles(particlesBytes!, oldScene, oldCount)
							},
							nextScene
						);
				const nextCapacity = Math.max(buffers.capacity, capacityFor(nextScene));
				const preserveHistoryPhase = !reset && !changedStride;
				const migrated = historyBytes
					? await preparer.migrate(nextPopulation.agents, nextScene, generation, nextCapacity, {
							particles: particlesBytes!,
							metrics: metricsBytes!,
							history: historyBytes,
							head: historyHead,
							valid: validHistory,
							oldInterval: historyStride(oldScene) * oldScene.dynamics.fixedDt,
							newInterval: historyStride(nextScene) * nextScene.dynamics.fixedDt,
							headElapsed: preserveHistoryPhase ? undefined : simulationTime - lastHistoryTime
						})
					: undefined;
				if (disposed || failed) return;
				// All asynchronous work finishes before swapping any live allocations.
				// Camera/rendering can keep using the old immutable buffers during migration.
				population = nextPopulation;
				if (reset) generation = population.generation;
				count = population.agents.length;
				if (count > buffers.capacity) buffers = allocatePopulation(count);
				const preserveCamera =
					reset &&
					oldScene.id === nextScene.id &&
					oldScene.seed === nextScene.seed &&
					oldScene.world.kind === nextScene.world.kind &&
					oldScene.world.shape === nextScene.world.shape &&
					JSON.stringify(oldScene.world) !== JSON.stringify(nextScene.world);
				scene = nextScene;
				particleSide = metricSide = 0;
				if (migrated) {
					for (const buffer of buffers.particles) buffer.write(migrated.particles);
					for (const buffer of buffers.metrics) buffer.write(migrated.metrics);
					buffers.history.write(migrated.history);
					validHistory = migrated.valid;
				} else {
					initializeBuffers(prepared!.particles);
					tick = simulationTime = historyHead = 0;
					validHistory = 1;
				}
				if (!preserveHistoryPhase) {
					lastHistoryTime = simulationTime;
					historyTicks = 0;
				}
				refreshDerived(prepared?.topology);
				if (buffers !== oldBuffers) {
					void gpu.gpu.queue.onSubmittedWorkDone().then(() => {
						if (!disposed)
							for (const buffer of [
								...oldBuffers.particles,
								...oldBuffers.metrics,
								oldBuffers.history,
								oldBuffers.indices
							])
								free(buffer);
					}, reportError);
				}
				if (reset) {
					requestedSteps = 0;
					selectedId = null;
					selectedSlot = -1;
					callbacks.onInspect?.(null);
					if (!preserveCamera && cameraRevision === cameraAtRequest)
						camera.definition = structuredClone(scene.camera);
				} else {
					selectedSlot = population.agents.findIndex((a) => a.id === selectedId);
					if (selectedSlot < 0) {
						selectedId = null;
						callbacks.onInspect?.(null);
					}
				}
				writeSpecies();
				bootstrap(reset ? 1 : 0, !preserveHistoryPhase);
			} else {
				const metricDemandChanged = metricMask !== requiredMetricMask(nextScene);
				const queryChanged =
					JSON.stringify(gridDefinition(scene)) !== JSON.stringify(gridDefinition(nextScene)) ||
					scene.species.some((s, i) => s.perception !== nextScene.species[i].perception);
				scene = nextScene;
				refreshDerived(prepared?.topology);
				writeSpecies();
				writeConfig();
				if (queryChanged || metricDemandChanged) bootstrap(0);
			}
			if (qualityChanged) resizeStage();
			if (changedPopulation || changedStride) {
				scheduler.reset();
				lastTime = performance.now();
			}
			dirty = true;
		} catch (error) {
			if (
				(committing || revision === sceneRevision) &&
				!(error instanceof DOMException && error.name === 'AbortError')
			)
				reportError(error);
		} finally {
			if (committing) busy = false;
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
		if (!busy && !pendingApplication && (pendingScene || requestedReset)) startPendingApplication();
		if (disposed || failed) return;
		try {
			camera.update(canvasTarget.size[0] / canvasTarget.size[1], elapsed);
			stageInput.refresh();
			if (camera.definition.autoRotate !== 0) dirty = true;
			if (!paused && !busy) {
				scheduler.record(
					elapsed,
					scene.dynamics.fixedDt,
					scene.dynamics.maxSubsteps,
					scene.dynamics.timeScale
				);
			}
			if (inFlight < 2) {
				if (!paused && !busy) {
					const steps = scheduler.take(scene.dynamics.fixedDt, scene.dynamics.maxSubsteps);
					for (let i = 0; i < steps; i++) physicsTick();
				} else if (!busy) {
					const steps = Math.min(requestedSteps, scene.dynamics.maxSubsteps);
					for (let i = 0; i < steps; i++) physicsTick();
					requestedSteps -= steps;
				}
				if (dirty) render();
				if (!busy && now - lastInspect > 200) {
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
			queuePreparation();
		},
		reset(value) {
			if (value) pendingScene = assertScene(structuredClone(value));
			selectionIntent++;
			requestedReset = true;
			queuePreparation();
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
			stageInput.refresh();
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
			cameraRevision++;
			camera.definition = structuredClone(value);
			dirty = true;
		},
		resetCamera() {
			cameraRevision++;
			const value = pendingScene ?? scene;
			camera.definition = {
				...structuredClone(value.camera),
				...(value.world.shape === 'trefoil' ? worldDefaultCamera(value.world) : {})
			};
			dirty = true;
		},
		fitCamera() {
			cameraRevision++;
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
							: isTopologyWorld(fitScene.world)
								? fitScene.world.radius
								: Math.hypot(...worldBounds(fitScene.world));
			const vertical = (Math.PI * 21) / 180;
			const angle = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
			camera.definition.target = [0, 0, 0];
			camera.definition.pan = [0, 0];
			camera.definition.distance =
				((radius + Math.max(...fitScene.species.map((s) => s.size)) * 2) / Math.sin(angle)) * 1.05;
			if (pendingScene && willReset) pendingScene.camera = structuredClone(camera.definition);
			dirty = true;
		},
		setAutoRotate(value) {
			cameraRevision++;
			camera.definition.autoRotate = value ? 0.08 : 0;
			dirty = true;
		},
		async screenshot() {
			while (!disposed && !failed && (pendingApplication || pendingScene || requestedReset)) {
				if (!pendingApplication) startPendingApplication();
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
			preparer.dispose();
			cancelAnimationFrame(raf);
			stageInput.dispose();
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
