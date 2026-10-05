import { initializePopulation } from '#lib/model';
import { packParticles } from './packing';
import { packTopologyWorld } from './topology-atlas';
import { migrateRuntime } from './migration';
import type { TopologyWorkerRequest, TopologyPreparationReply } from './topology-preparation';

/** Pure worker job, kept importable for seeded initialization/packing parity tests. */
export function prepareTopologyJob(data: TopologyWorkerRequest): TopologyPreparationReply {
	try {
		if (data.type === 'migrate')
			return {
				type: 'migrated',
				id: data.id,
				result: migrateRuntime(
					data.agents,
					data.scene,
					data.generation,
					data.capacity,
					data.snapshot
				)
			};
		const topology = packTopologyWorld(data.scene.world, data.scene.obstacles.length);
		const population = data.reset
			? initializePopulation(data.scene, data.reset.generation)
			: undefined;
		const particles =
			population && data.reset
				? packParticles(population.agents, data.scene, data.reset.generation, data.reset.capacity)
				: undefined;
		return { type: 'ready', id: data.id, buffer: topology.buffer, population, particles };
	} catch (error) {
		return {
			type: 'error',
			id: data.id,
			message: error instanceof Error ? error.message : String(error)
		};
	}
}
