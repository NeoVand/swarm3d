import type { Gpu } from 'vgpu';
import type { Buffer as CoreBuffer } from 'vgpu/core';
import { ALL_METRICS_MASK, usesBasicNeighborhoodMetrics } from './metric-demand';

type Shader = string | { readonly wgsl: string };
type Pair = [CoreBuffer, CoreBuffer];
export interface ComputeBuffers {
	config: CoreBuffer;
	particles: Pair;
	metrics: Pair;
	history: CoreBuffer;
	grid: CoreBuffer;
	indices: CoreBuffer;
	blocks: CoreBuffer;
	species: CoreBuffer;
	pairRules: CoreBuffer;
}

const gridEntries = [
	'clear_grid',
	'count_particles',
	'prefix_cells',
	'prefix_blocks',
	'finish_prefix',
	'scatter_particles'
] as const;

/** vgpu owns buffers/rendering; public WebGPU encodes a whole coherent tick once.
 * Each submission uses one configuration snapshot. Never queue.writeBuffer several
 * tick configurations before submitting the encoder that consumes them.
 */
export async function createComputeRuntime(
	gpu: Gpu,
	shaders: { grid: Shader; simulation: Shader; metrics: Shader; history: Shader },
	initial: ComputeBuffers
) {
	const device = gpu.gpu;
	const makeLayout = (types: GPUBufferBindingType[]) =>
		device.createBindGroupLayout({
			entries: types.map((type, binding) => ({
				binding,
				visibility: GPUShaderStage.COMPUTE,
				buffer: { type }
			}))
		});
	const layouts = {
		grid: makeLayout(['read-only-storage', 'read-only-storage', 'storage', 'storage', 'storage']),
		simulation: makeLayout([
			'read-only-storage',
			'read-only-storage',
			'storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage'
		]),
		metrics: makeLayout([
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage'
		]),
		history: makeLayout([
			'read-only-storage',
			'read-only-storage',
			'storage',
			'read-only-storage',
			'read-only-storage'
		])
	};
	const pipeline = async (
		name: keyof typeof shaders,
		entries: readonly string[],
		constants?: readonly Record<string, number>[]
	) => {
		const source = shaders[name];
		const module = device.createShaderModule({
			label: `${name} shader`,
			code: typeof source === 'string' ? source : source.wgsl
		});
		const diagnostics = await module.getCompilationInfo();
		const errors = diagnostics.messages.filter((message) => message.type === 'error');
		if (errors.length)
			throw new Error(
				errors.map((error) => `${name}:${error.lineNum}: ${error.message}`).join('\n')
			);
		const layout = device.createPipelineLayout({ bindGroupLayouts: [layouts[name]] });
		return await Promise.all(
			entries.map((entryPoint, index) =>
				device.createComputePipelineAsync({
					label: entryPoint,
					layout,
					compute: { module, entryPoint, constants: constants?.[index] }
				})
			)
		);
	};
	const [
		gridPipelines,
		[simulation, sphereSimulation, planeSimulation, cylinderSimulation],
		[metrics, completeMetrics, basicMetrics],
		[history]
	] = await Promise.all([
		pipeline('grid', gridEntries),
		// Keep volume/torus and diagnostic calls on the generic solver. These
		// three surface constants retain strict parity with its physical output.
		pipeline(
			'simulation',
			['simulate', 'simulate', 'simulate', 'simulate'],
			[{ '0': 99 }, { '0': 1 }, { '0': 2 }, { '0': 3 }]
		),
		// Three fixed variants share a module/layout and all cached bindings.
		// Overrides remove unreachable dependencies without changing neighborhoods.
		pipeline(
			'metrics',
			['measure', 'measure', 'measure'],
			[
				{ '0': 0, '1': 0 },
				{ '0': 1, '1': 0 },
				{ '0': 0, '1': 1 }
			]
		),
		pipeline('history', ['write_history'])
	]);
	const group = (layout: GPUBindGroupLayout, buffers: CoreBuffer[]) =>
		device.createBindGroup({
			layout,
			entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer: buffer.gpu } }))
		});
	let groups: ReturnType<typeof bind>;
	function bind(b: ComputeBuffers) {
		return {
			grid: b.particles.map((p) => group(layouts.grid, [b.config, p, b.grid, b.indices, b.blocks])),
			history: b.particles.map((p) =>
				b.metrics.map((m) => group(layouts.history, [b.config, p, b.history, m, b.species]))
			),
			simulation: b.particles.map((p, i) =>
				b.metrics.map((m) =>
					group(layouts.simulation, [
						b.config,
						p,
						b.particles[1 - i],
						b.grid,
						b.indices,
						m,
						b.species,
						b.pairRules
					])
				)
			),
			metrics: b.particles.map((p) =>
				b.metrics.map((m, i) =>
					group(layouts.metrics, [b.config, p, m, b.metrics[1 - i], b.grid, b.indices, b.species])
				)
			)
		};
	}
	groups = bind(initial);
	function dispatch(
		pass: GPUComputePassEncoder,
		pipeline: GPUComputePipeline,
		bindings: GPUBindGroup,
		count: number
	) {
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindings);
		pass.dispatchWorkgroups(count);
	}
	function index(pass: GPUComputePassEncoder, side: number, count: number, cells: number) {
		const cellGroups = Math.ceil(cells / 256),
			agentGroups = Math.ceil(count / 256);
		const counts = [cellGroups, agentGroups, cellGroups, 1, cellGroups, agentGroups];
		gridPipelines.forEach((pipeline, i) => {
			// The cell scan already writes global offsets when there is just one block.
			if (cellGroups === 1 && (i === 3 || i === 4)) return;
			dispatch(pass, pipeline, groups.grid[side], counts[i]);
		});
	}
	function submit(operation: (pass: GPUComputePassEncoder) => void) {
		const encoder = device.createCommandEncoder({ label: 'coherent simulation' });
		const pass = encoder.beginComputePass();
		operation(pass);
		pass.end();
		device.queue.submit([encoder.finish()]);
	}
	function measurementPipeline(metricMask: number, selectedId: number) {
		if (metricMask === ALL_METRICS_MASK) return completeMetrics;
		if (selectedId === 0 && usesBasicNeighborhoodMetrics(metricMask)) return basicMetrics;
		return metrics;
	}
	function simulationPipeline(worldKind: number) {
		if (worldKind === 1) return sphereSimulation;
		if (worldKind === 2) return planeSimulation;
		if (worldKind === 3) return cylinderSimulation;
		return simulation;
	}
	return {
		rebind(buffers: ComputeBuffers) {
			groups = bind(buffers);
		},
		bootstrap(
			particleSide: number,
			metricSide: number,
			count: number,
			cells: number,
			metricMask = ALL_METRICS_MASK,
			selectedId = 0
		) {
			submit((pass) => {
				index(pass, particleSide, count, cells);
				dispatch(
					pass,
					measurementPipeline(metricMask, selectedId),
					groups.metrics[particleSide][metricSide],
					Math.ceil(count / 128)
				);
				dispatch(
					pass,
					history,
					groups.history[particleSide][1 - metricSide],
					Math.ceil(count / 128)
				);
			});
		},
		tick(
			particleSide: number,
			metricSide: number,
			count: number,
			cells: number,
			sampleHistory: boolean,
			metricMask = ALL_METRICS_MASK,
			selectedId = 0,
			worldKind = 8
		) {
			submit((pass) => {
				dispatch(
					pass,
					simulationPipeline(worldKind),
					groups.simulation[particleSide][metricSide],
					Math.ceil(count / 128)
				);
				const next = 1 - particleSide;
				index(pass, next, count, cells);
				dispatch(
					pass,
					measurementPipeline(metricMask, selectedId),
					groups.metrics[next][metricSide],
					Math.ceil(count / 128)
				);
				if (sampleHistory)
					dispatch(pass, history, groups.history[next][1 - metricSide], Math.ceil(count / 128));
			});
		}
	};
}
