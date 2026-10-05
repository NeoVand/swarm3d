import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gpu } from 'vgpu';
import type { Buffer as CoreBuffer } from 'vgpu/core';
import { createComputeRuntime } from './compute-runtime';
import type { ComputeBuffers } from './compute-runtime';
import { ALL_METRICS_MASK, LOCAL_METRICS_MASK } from './metric-demand';

function fixture() {
	const compiled: GPUComputePipelineDescriptor[] = [];
	const dispatched: GPUComputePipelineDescriptor[] = [];
	const bindings: { entries: GPUBindGroupEntry[] }[] = [];
	const device = {
		createBindGroupLayout: (options: unknown) => options,
		createPipelineLayout: (options: unknown) => options,
		createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
		async createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor) {
			compiled.push(descriptor);
			return { descriptor };
		},
		createBindGroup: (options: unknown) => options,
		createCommandEncoder: () => ({
			beginComputePass: () => ({
				setPipeline: (pipeline: { descriptor: GPUComputePipelineDescriptor }) =>
					dispatched.push(pipeline.descriptor),
				setBindGroup(_index: number, options: { entries: GPUBindGroupEntry[] }) {
					bindings.push(options);
				},
				dispatchWorkgroups() {},
				end() {}
			}),
			finish() {}
		}),
		queue: { submit() {} }
	};
	let identity = 0;
	const buffer = () => ({ gpu: { identity: ++identity } }) as unknown as CoreBuffer;
	const buffers: ComputeBuffers = {
		config: buffer(),
		particles: [buffer(), buffer()],
		metrics: [buffer(), buffer()],
		history: buffer(),
		grid: buffer(),
		indices: buffer(),
		blocks: buffer(),
		species: buffer(),
		pairRules: buffer()
	};
	return { gpu: { gpu: device } as unknown as Gpu, buffers, compiled, dispatched, bindings };
}

describe('bounded compute pipeline specialization', () => {
	beforeEach(() => vi.stubGlobal('GPUShaderStage', { COMPUTE: 4 }));
	afterEach(() => vi.unstubAllGlobals());

	it('compiles three fixed variants and guards selection and unsupported dependencies without recompilation', async () => {
		const state = fixture();
		const runtime = await createComputeRuntime(
			state.gpu,
			{ grid: '', simulation: '', metrics: '', history: '' },
			state.buffers
		);
		const measurements = state.compiled.filter(
			(descriptor) => descriptor.compute.entryPoint === 'measure'
		);
		expect(measurements).toHaveLength(3);
		expect(measurements.map((descriptor) => descriptor.compute.constants)).toEqual([
			{ '0': 0, '1': 0 },
			{ '0': 1, '1': 0 },
			{ '0': 0, '1': 1 }
		]);
		const initialPipelineCount = state.compiled.length;
		const cases = [
			{ mask: LOCAL_METRICS_MASK, selectedId: 0, mode: '0/0' },
			{ mask: ALL_METRICS_MASK, selectedId: 0, mode: '1/0' },
			{ mask: LOCAL_METRICS_MASK | (1 << 5), selectedId: 0, mode: '0/0' },
			{ mask: 71, selectedId: 0, mode: '0/1' },
			{ mask: 87, selectedId: 0, mode: '0/1' },
			{ mask: 351, selectedId: 0, mode: '0/1' },
			{ mask: 15, selectedId: 0, mode: '0/1' },
			{ mask: 23, selectedId: 0, mode: '0/1' },
			{ mask: 263, selectedId: 0, mode: '0/0' },
			{ mask: 71 | (1 << 7), selectedId: 0, mode: '0/0' },
			{ mask: 71, selectedId: 123, mode: '0/0' },
			{ mask: 23, selectedId: 123, mode: '0/0' },
			{ mask: ALL_METRICS_MASK, selectedId: 123, mode: '1/0' }
		];
		for (const { mask, selectedId } of cases) {
			runtime.bootstrap(0, 0, 128, 512, mask, selectedId);
			runtime.tick(0, 1, 128, 512, false, mask, selectedId);
		}
		const measuredModes = state.dispatched
			.filter((descriptor) => descriptor.compute.entryPoint === 'measure')
			.map(
				(descriptor) =>
					`${descriptor.compute.constants?.['0']}/${descriptor.compute.constants?.['1']}`
			);
		expect(measuredModes).toEqual(cases.flatMap(({ mode }) => [mode, mode]));
		expect(state.compiled).toHaveLength(initialPipelineCount);
	});

	it('keeps omitted diagnostic masks complete through bootstrap, tick and buffer rebinding', async () => {
		const state = fixture();
		const runtime = await createComputeRuntime(
			state.gpu,
			{ grid: '', simulation: '', metrics: '', history: '' },
			state.buffers
		);
		runtime.bootstrap(0, 0, 128, 512);
		runtime.rebind(state.buffers);
		runtime.tick(0, 1, 128, 512, true);
		expect(
			state.dispatched
				.filter((descriptor) => descriptor.compute.entryPoint === 'measure')
				.map((descriptor) => descriptor.compute.constants?.['0'])
		).toEqual([1, 1]);
		expect(
			state.compiled.filter((descriptor) => descriptor.compute.entryPoint === 'measure')
		).toHaveLength(3);
	});

	it('rebinds replacement buffers for the specialized variant without recompiling its pipeline', async () => {
		const state = fixture();
		const runtime = await createComputeRuntime(
			state.gpu,
			{ grid: '', simulation: '', metrics: '', history: '' },
			state.buffers
		);
		runtime.bootstrap(0, 0, 128, 512, 87);
		const pipelineCount = state.compiled.length;
		const replacement = fixture().buffers;
		runtime.rebind(replacement);
		state.bindings.length = 0;
		runtime.tick(1, 1, 128, 512, true, 71);
		for (const group of state.bindings)
			expect((group.entries[0].resource as GPUBufferBinding).buffer).toBe(replacement.config.gpu);
		const lastMeasurement = state.dispatched
			.filter((descriptor) => descriptor.compute.entryPoint === 'measure')
			.at(-1);
		expect(lastMeasurement?.compute.constants).toEqual({ '0': 0, '1': 1 });
		expect(state.compiled).toHaveLength(pipelineCount);
	});

	it('precompiles four simulation variants and switches completed world snapshots without recompilation', async () => {
		const state = fixture();
		const runtime = await createComputeRuntime(
			state.gpu,
			{ grid: '', simulation: '', metrics: '', history: '' },
			state.buffers
		);
		const solvers = state.compiled.filter(
			(descriptor) => descriptor.compute.entryPoint === 'simulate'
		);
		expect(solvers.map((descriptor) => descriptor.compute.constants)).toEqual([
			{ '0': 5 },
			{ '0': 1 },
			{ '0': 2 },
			{ '0': 3 }
		]);
		const pipelineCount = state.compiled.length;
		// Sphere→torus→plane→cylinder→volume transitions use the same cached
		// layouts/bindings; unsafe-to-specialize worlds retain the generic solver.
		for (const worldKind of [1, 4, 2, 3, 0, 5])
			runtime.tick(0, 1, 128, 512, false, LOCAL_METRICS_MASK, 0, worldKind);
		expect(
			state.dispatched
				.filter((descriptor) => descriptor.compute.entryPoint === 'simulate')
				.map((descriptor) => descriptor.compute.constants?.['0'])
		).toEqual([1, 5, 2, 3, 5, 5]);
		expect(state.compiled).toHaveLength(pipelineCount);
	});

	it('uses the dynamic solver when diagnostic calls omit the world selector', async () => {
		const state = fixture();
		const runtime = await createComputeRuntime(
			state.gpu,
			{ grid: '', simulation: '', metrics: '', history: '' },
			state.buffers
		);
		runtime.tick(1, 0, 128, 512, true);
		expect(
			state.dispatched.find((descriptor) => descriptor.compute.entryPoint === 'simulate')?.compute
				.constants
		).toEqual({ '0': 5 });
	});

	it('reuses each simulation pipeline with replacement state and both ping-pong directions', async () => {
		const state = fixture();
		const runtime = await createComputeRuntime(
			state.gpu,
			{ grid: '', simulation: '', metrics: '', history: '' },
			state.buffers
		);
		const pipelineCount = state.compiled.length;
		const replacement = fixture().buffers;
		runtime.rebind(replacement);
		for (const [particleSide, metricSide, worldKind] of [
			[0, 1, 1],
			[1, 0, 2],
			[0, 0, 3],
			[1, 1, 4]
		]) {
			state.bindings.length = 0;
			runtime.tick(particleSide, metricSide, 128, 512, false, LOCAL_METRICS_MASK, 0, worldKind);
			const resources = state.bindings[0].entries.map(
				(entry) => (entry.resource as GPUBufferBinding).buffer
			);
			const expected = [
				replacement.config.gpu,
				replacement.particles[particleSide].gpu,
				replacement.particles[1 - particleSide].gpu,
				replacement.grid.gpu,
				replacement.indices.gpu,
				replacement.metrics[metricSide].gpu,
				replacement.species.gpu,
				replacement.pairRules.gpu
			];
			for (let binding = 0; binding < expected.length; binding++)
				expect(resources[binding]).toBe(expected[binding]);
		}
		expect(state.compiled).toHaveLength(pipelineCount);
	});
});
