import { describe, expect, it } from 'vitest';
import { createDefaultScene, initializePopulation } from '#lib/model';
import type { WorldDefinition } from '#lib/model';
import { packParticles } from './packing';
import { prepareTopologyJob } from './topology-preparation-job';
import { migrateRuntime } from './migration';

const worlds: WorldDefinition[] = [
	{ kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' },
	{ kind: 'volume', shape: 'sphere', radius: 14 },
	{ kind: 'volume', shape: 'cylinder', radius: 14, halfHeight: 14 },
	{ kind: 'volume', shape: 'torus', majorRadius: 20, tubeRadius: 6 },
	{ kind: 'surface', shape: 'sphere', radius: 14 },
	{ kind: 'surface', shape: 'plane', halfExtents: [18, 12], boundaries: 'periodic' },
	{ kind: 'surface', shape: 'cylinder', radius: 14, halfHeight: 14 },
	{ kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 6 },
	{ kind: 'surface', shape: 'mobius', radius: 14 },
	{ kind: 'surface', shape: 'klein', radius: 14 },
	{ kind: 'surface', shape: 'projective', radius: 14 },
	{ kind: 'surface', shape: 'trefoil', radius: 14, tubeRadius: 0.84 }
];
describe('pure transferable world preparation', () => {
	it('migrates stable identity, metrics and real history with transferable result buffers', () => {
		const scene = createDefaultScene();
		scene.species.forEach((species) => (species.population = 2));
		const agents = initializePopulation(scene, 3).agents;
		const snapshot = {
			particles: packParticles(agents, scene, 3, 4),
			metrics: new Float32Array(64).buffer,
			history: new Float32Array(4 * 64 * 8).buffer,
			head: 0,
			valid: 1,
			oldInterval: 1,
			newInterval: 0.5
		};
		const expected = migrateRuntime(agents, scene, 3, 8, snapshot);
		const reply = prepareTopologyJob({
			type: 'migrate',
			id: 9,
			scene,
			agents,
			generation: 3,
			capacity: 8,
			snapshot
		});
		expect(reply.type).toBe('migrated');
		if (reply.type !== 'migrated') return;
		expect(reply.result).toEqual(expected);
		const transfers = [
			reply.result.particles,
			reply.result.metrics.buffer,
			reply.result.history.buffer
		];
		const cloned = structuredClone(reply, { transfer: transfers });
		expect(transfers.every((buffer) => buffer.byteLength === 0)).toBe(true);
		expect(cloned.result.history.length).toBe(8 * 64 * 8);
		expect(cloned.result.metrics.length).toBe(8 * 16);
	});
	it.each(worlds)(
		'matches seeded state and packed identity for $kind/$shape resets',
		(world) => {
			const scene = createDefaultScene();
			scene.world = world;
			scene.species.forEach((species) => (species.population = 4));
			const reply = prepareTopologyJob({
				type: 'prepare',
				id: 7,
				scene,
				reset: { generation: 19, capacity: 16 }
			});
			expect(reply.type).toBe('ready');
			if (reply.type !== 'ready') return;
			const expected = initializePopulation(scene, 19);
			expect(reply.population).toEqual(expected);
			expect(new Uint8Array(reply.particles!)).toEqual(
				new Uint8Array(packParticles(expected.agents, scene, 19, 16))
			);
			const transferred = structuredClone(reply, { transfer: [reply.buffer, reply.particles!] });
			expect(reply.particles!.byteLength).toBe(0);
			expect(transferred.particles!.byteLength).toBe(16 * 64);
			// Transferring an owned output must not detach the cached normalized atlas.
			const again = prepareTopologyJob({ type: 'prepare', id: 8, scene });
			expect(again.type).toBe('ready');
			if (again.type === 'ready') {
				const preserved = new Uint8Array(transferred.buffer);
				expect(new Uint8Array(again.buffer).every((value, i) => value === preserved[i])).toBe(true);
				expect(again.population).toBeUndefined();
				expect(again.particles).toBeUndefined();
			}
		},
		10_000
	);
});
