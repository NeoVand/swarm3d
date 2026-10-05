import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultScene } from '#lib/model';
import { createEngine } from './engine';
import { StageCamera } from './camera';
import { agentRenderCenter } from './surface-render';
import type { Engine } from './contracts';

const runtime = vi.hoisted(() => {
	class Buffer {
		bytes: Uint8Array;
		destroyed = false;
		constructor(public options: { label: string; size: number }) {
			this.bytes = new Uint8Array(options.size);
		}
		write(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>, offset = 0) {
			if (this.destroyed) throw new Error('Write after disposal');
			const bytes =
				data instanceof ArrayBuffer
					? new Uint8Array(data)
					: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			this.bytes.set(bytes, offset);
		}
		async read(length: number, offset = 0) {
			state.reads++;
			const bytes = this.bytes.slice(offset, offset + length).buffer;
			await state.readGate;
			return bytes;
		}
		destroy() {
			this.destroyed = true;
		}
	}
	const state = {
		buffers: [] as Buffer[],
		hues: [] as number[],
		ticks: 0,
		reads: 0,
		measurementMasks: [] as number[],
		readGate: null as Promise<void> | null,
		queueGate: null as Promise<void> | null
	};
	const drawable = () => ({ set() {}, compile: async () => {} });
	return {
		state,
		gpu: {
			device: {
				createBuffer(options: { label: string; size: number }) {
					const buffer = new Buffer(options);
					state.buffers.push(buffer);
					return buffer;
				}
			},
			gpu: {
				limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 },
				queue: { onSubmittedWorkDone: () => state.queueGate ?? Promise.resolve() },
				lost: new Promise<never>(() => {}),
				addEventListener() {},
				removeEventListener() {}
			},
			onError: () => () => {},
			settled: async () => {},
			dispose() {}
		},
		drawable,
		frame(_gpu: unknown, callback: (frame: { pass: () => void }) => void) {
			callback({ pass() {} });
			const species = state.buffers.find(
				(buffer) => buffer.options.label === 'species configuration'
			);
			state.hues.push(new Float32Array(species!.bytes.buffer)[16]);
			return { done: Promise.resolve() };
		},
		compute: {
			bootstrap() {
				const config = state.buffers.find(
					(buffer) => buffer.options.label === 'world configuration'
				);
				state.measurementMasks.push(new Float32Array(config!.bytes.buffer)[55]);
			},
			rebind() {},
			tick: () => state.ticks++
		}
	};
});

vi.mock('vgpu', () => ({
	init: async () => runtime.gpu,
	draw: runtime.drawable,
	effect: runtime.drawable,
	frame: runtime.frame,
	sampler: () => ({}),
	uniforms: () => ({ set() {} }),
	surface: () => ({
		size: [800, 600],
		dpr: 1,
		format: 'bgra8unorm',
		onResize: () => () => {}
	}),
	target: (_gpu: unknown, options: { size: [number, number] }) => ({
		size: options.size,
		texelSize: options.size.map((value) => 1 / value),
		resize() {}
	})
}));
vi.mock('./compute-runtime', () => ({ createComputeRuntime: async () => runtime.compute }));
vi.mock('./input', () => ({ attachStageInput: () => ({ refresh() {}, dispose() {} }) }));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve };
}

describe('configuration commits in the animation loop', () => {
	let engine: Engine;
	let now: number;
	let nextFrame: FrameRequestCallback | null;
	let errors: unknown[];
	const scene = () => {
		const definition = createDefaultScene();
		definition.species.forEach((species) => (species.population = 4));
		return definition;
	};
	const settle = async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	};
	const advance = async (milliseconds = 1000 / 120) => {
		now += milliseconds;
		const callback = nextFrame!;
		nextFrame = null;
		callback(now);
		await settle();
	};

	beforeEach(async () => {
		now = 0;
		nextFrame = null;
		errors = [];
		runtime.state.buffers = [];
		runtime.state.hues = [];
		runtime.state.ticks = 0;
		runtime.state.reads = 0;
		runtime.state.measurementMasks = [];
		runtime.state.readGate = null;
		runtime.state.queueGate = null;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		vi.stubGlobal('navigator', { gpu: {} });
		vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			nextFrame = callback;
			return 1;
		});
		vi.stubGlobal('cancelAnimationFrame', () => (nextFrame = null));
		engine = await createEngine(
			{
				getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 })
			} as HTMLCanvasElement,
			scene(),
			{
				onError: (error) => errors.push(error)
			}
		);
	});
	afterEach(() => {
		engine.dispose();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('renders every continuous appearance edit and keeps fractional ticks at 120 Hz', async () => {
		const definition = scene();
		const allocations = runtime.state.buffers.length;
		for (let i = 0; i < 120; i++) {
			const [, saturation, lightness] = definition.species[0].visual.hsl;
			definition.species[0].visual.hsl = [i / 120, saturation, lightness];
			engine.updateScene(definition);
			await advance();
			expect(runtime.state.hues).toHaveLength(i + 1);
			expect(runtime.state.hues[i]).toBeCloseTo(i / 120, 6);
		}
		expect(runtime.state.ticks).toBe(60);
		expect(runtime.state.buffers).toHaveLength(allocations);
		expect(runtime.state.reads).toBe(0);
		expect(errors).toEqual([]);
	});

	it('redraws sustained appearance edits while paused without advancing physics', async () => {
		engine.setPaused(true);
		const definition = scene();
		for (let i = 0; i < 24; i++) {
			const [, saturation, lightness] = definition.species[0].visual.hsl;
			definition.species[0].visual.hsl = [i / 24, saturation, lightness];
			engine.updateScene(definition);
			await advance();
		}
		expect(runtime.state.hues).toHaveLength(24);
		expect(runtime.state.hues[23]).toBeCloseTo(23 / 24, 6);
		expect(runtime.state.ticks).toBe(0);
		expect(runtime.state.reads).toBe(0);
		expect(errors).toEqual([]);
	});

	it('initializes newly enabled color measurements while paused before drawing the next frame', async () => {
		engine.setPaused(true);
		const definition = scene();
		expect(runtime.state.measurementMasks).toEqual([7]);
		definition.species[0].visual.hue = {
			...definition.species[0].visual.hue,
			enabled: true,
			source: 'anisotropy'
		};
		engine.updateScene(definition);
		await advance();
		expect(runtime.state.measurementMasks).toEqual([7, 7 | (1 << 5)]);
		expect(runtime.state.hues).toHaveLength(1);
		expect(runtime.state.ticks).toBe(0);
		expect(runtime.state.reads).toBe(0);
		definition.species[0].visual.hue.strength = 0.5;
		engine.updateScene(definition);
		await advance();
		expect(runtime.state.measurementMasks).toHaveLength(2);
		definition.species[0].visual.hue.enabled = false;
		engine.updateScene(definition);
		await advance();
		expect(runtime.state.measurementMasks).toEqual([7, 7 | (1 << 5), 7]);
		expect(runtime.state.ticks).toBe(0);
		expect(errors).toEqual([]);
	});

	it('refreshes selected identity measurements before a paused inspection readback', async () => {
		engine.setPaused(true);
		const camera = new StageCamera(engine.getCamera());
		camera.update(800 / 600);
		const particles = runtime.state.buffers.find((buffer) => buffer.options.label === 'agents A')!;
		const values = new Float32Array(particles.bytes.buffer);
		const identity = new Uint32Array(particles.bytes.buffer);
		const projected = camera.project([values[0], values[1], values[2]]);
		await engine.selectAt((projected[0] * 0.5 + 0.5) * 800, (0.5 - projected[1] * 0.5) * 600);
		const config = runtime.state.buffers.find(
			(buffer) => buffer.options.label === 'world configuration'
		)!;
		expect(new Uint32Array(config.bytes.buffer)[59]).toBe(identity[12]);
		expect(new Float32Array(config.bytes.buffer)[36]).toBe(0);
		expect(runtime.state.measurementMasks).toEqual([7, 7]);
		expect(runtime.state.reads).toBe(3); // Pick once, then one selected particle and Metrics record.
		expect(runtime.state.ticks).toBe(0);
		expect(errors).toEqual([]);
	});

	it('picks the shifted visual body center from a close inside-cylinder camera', async () => {
		engine.setPaused(true);
		const definition = scene();
		definition.world = { kind: 'surface', shape: 'cylinder', radius: 20, halfHeight: 24 };
		definition.species = [definition.species[0]];
		definition.species[0].population = 1;
		definition.speciesRules = [];
		engine.reset(definition);
		await advance();
		const particles = runtime.state.buffers.find(
			(buffer) => !buffer.destroyed && buffer.options.label === 'agents A'
		)!;
		const values = new Float32Array(particles.bytes.buffer),
			identity = new Uint32Array(particles.bytes.buffer);
		const point = [values[0], values[1], values[2]] as const;
		const radial = Math.hypot(point[0], point[2]);
		const eye = [
			point[0] * 0.98 - (point[2] / radial) * 0.2,
			point[1],
			point[2] * 0.98 + (point[0] / radial) * 0.2
		] as const;
		const relative = [eye[0] - point[0], eye[1] - point[1], eye[2] - point[2]] as const;
		const framing = {
			target: point,
			distance: Math.hypot(...relative),
			yaw: Math.atan2(relative[0], relative[2]),
			pitch: 0,
			autoRotate: 0
		};
		engine.setCamera(framing);
		await advance();
		const camera = new StageCamera(framing);
		camera.update(800 / 600);
		const center = agentRenderCenter(
			definition.world,
			point,
			definition.species[0].size,
			camera.position
		);
		const visual = camera.project(center),
			physical = camera.project(point);
		expect(Math.abs(visual[0] - physical[0]) * 400).toBeGreaterThan(24);
		await engine.selectAt((visual[0] * 0.5 + 0.5) * 800, (0.5 - visual[1] * 0.5) * 600);
		const config = runtime.state.buffers.find(
			(buffer) => buffer.options.label === 'world configuration'
		)!;
		expect(new Uint32Array(config.bytes.buffer)[59]).toBe(identity[12]);
		expect(errors).toEqual([]);
	});
	it('rejects a stale pick after selection is cleared while the particle readback is pending', async () => {
		const gate = deferred();
		runtime.state.readGate = gate.promise;
		const pending = engine.selectAt(400, 300);
		engine.clearSelection();
		gate.resolve();
		await pending;
		expect(runtime.state.measurementMasks).toEqual([7]);
		expect(runtime.state.reads).toBe(1);
		expect(errors).toEqual([]);
	});

	it('retains the frame limit and bounded clock debt while edits arrive during GPU backpressure', async () => {
		const gate = deferred();
		runtime.state.queueGate = gate.promise;
		const definition = scene();
		for (let i = 0; i < 60; i++) {
			const [, saturation, lightness] = definition.species[0].visual.hsl;
			definition.species[0].visual.hsl = [i / 60, saturation, lightness];
			engine.updateScene(definition);
			await advance(1000 / 60);
		}
		expect(runtime.state.hues).toHaveLength(2);
		expect(runtime.state.ticks).toBe(2);
		gate.resolve();
		runtime.state.queueGate = null;
		await settle();
		await advance(1000 / 60);
		expect(runtime.state.hues).toHaveLength(3);
		expect(runtime.state.hues[2]).toBeCloseTo(59 / 60, 6);
		expect(runtime.state.ticks).toBe(6);
		expect(errors).toEqual([]);
	});

	it('blocks drawing during asynchronous history migration then commits queued appearance edits', async () => {
		await advance();
		const gate = deferred();
		runtime.state.readGate = gate.promise;
		const definition = scene();
		definition.species[0].population = 5;
		engine.updateScene(definition);
		await advance();
		expect(runtime.state.reads).toBe(3);
		for (let i = 0; i < 8; i++) {
			const [, saturation, lightness] = definition.species[0].visual.hsl;
			definition.species[0].visual.hsl = [i / 8, saturation, lightness];
			engine.updateScene(definition);
			await advance();
		}
		expect(runtime.state.hues).toHaveLength(1);
		expect(runtime.state.ticks).toBe(0);
		gate.resolve();
		await settle();
		await advance();
		expect(runtime.state.hues).toHaveLength(2);
		expect(runtime.state.hues[1]).toBeCloseTo(7 / 8, 6);
		expect(runtime.state.ticks).toBe(0);
		await advance();
		expect(runtime.state.ticks).toBe(1);
		expect(errors).toEqual([]);
	});

	it('does not resume a migration or draw after disposal while readbacks are pending', async () => {
		const gate = deferred();
		runtime.state.readGate = gate.promise;
		const definition = scene();
		definition.species[0].population = 5;
		engine.updateScene(definition);
		await advance();
		engine.dispose();
		gate.resolve();
		await settle();
		expect(runtime.state.reads).toBe(3);
		expect(runtime.state.buffers.every((buffer) => buffer.destroyed)).toBe(true);
		expect(runtime.state.hues).toHaveLength(0);
		expect(runtime.state.ticks).toBe(0);
		expect(nextFrame).toBeNull();
		expect(errors).toEqual([]);
	});
});
