import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultScene } from '#lib/model';
import { createEngine } from './engine';
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
		compute: { bootstrap() {}, rebind() {}, tick: () => state.ticks++ }
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
vi.mock('./input', () => ({ attachStageInput: () => () => {} }));

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
		engine = await createEngine({} as HTMLCanvasElement, scene(), {
			onError: (error) => errors.push(error)
		});
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
