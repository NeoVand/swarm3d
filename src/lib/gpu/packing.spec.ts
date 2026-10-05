import { describe, expect, it } from 'vitest';
import { createDefaultScene } from '#lib/model';
import { gridDefinition, interactionRadii, packConfig, packSpecies } from './packing';

describe('complete physical query packing', () => {
	it('packs plane topology with a single flat grid layer and no fabricated sphere radius', () => {
		const scene = createDefaultScene();
		scene.world = {
			kind: 'surface',
			shape: 'plane',
			halfExtents: [7.1, 5.3],
			boundaries: 'periodic'
		};
		const grid = gridDefinition(scene);
		const config = packConfig(scene, {
			population: 5000,
			tick: 0,
			historyHead: 0,
			validHistory: 1
		});
		expect(grid.half).toEqual([7.1, 0, 5.3]);
		expect(grid.dims[1]).toBe(1);
		expect(config[2]).toBe(2);
		expect(config[5]).toBe(0);
		expect(config[11]).toBe(1);
	});
	it('packs cylinder radius and bounded height separately from angular periodicity', () => {
		const scene = createDefaultScene();
		scene.world = { kind: 'surface', shape: 'cylinder', radius: 8, halfHeight: 11 };
		const grid = gridDefinition(scene);
		const config = packConfig(scene, {
			population: 5000,
			tick: 0,
			historyHead: 0,
			validHistory: 1
		});
		expect(grid.half).toEqual([8, 11, 8]);
		expect(config[2]).toBe(3);
		expect(config[5]).toBe(8);
		expect(config[9]).toBe(11);
		expect(config[11]).toBe(0);
	});
	it('expands only the observer with an active long-range rule, without coarsening the grid', () => {
		const scene = createDefaultScene();
		const before = gridDefinition(scene);
		const [a, b] = scene.species;
		scene.speciesRules = [
			{ id: 'far', from: a.key, to: b.key, behavior: 'chase', strength: 1, radius: 12 }
		];
		expect(interactionRadii(scene)).toEqual([12, b.perception]);
		expect(gridDefinition(scene).width).toBe(before.width);
		expect(gridDefinition(scene).radius).toBe(12);
		expect(packSpecies(scene)[6 * 4]).toBe(12);
	});
	it('honors explicit Ignore and zero-strength overrides when deriving fallback reach', () => {
		const scene = createDefaultScene();
		const [a, b] = scene.species;
		scene.speciesRules = [
			{ id: 'all', from: a.key, to: '*', behavior: 'flee', strength: 1, radius: 12 },
			{ id: 'off', from: a.key, to: b.key, behavior: 'ignore', strength: 8, radius: 20 }
		];
		expect(interactionRadii(scene)[0]).toBe(a.perception);
		scene.speciesRules[1].behavior = 'chase';
		scene.speciesRules[1].strength = 0;
		expect(interactionRadii(scene)[0]).toBe(a.perception);
		scene.speciesRules.pop();
		expect(interactionRadii(scene)[0]).toBe(12);
	});
	it('includes larger bodies even when soft avoidance is disabled', () => {
		const scene = createDefaultScene();
		const [a, b] = scene.species;
		a.size = 0.5;
		b.size = 4;
		scene.species.forEach((s) => (s.perception = 0.1));
		scene.dynamics.collision = 0;
		expect(interactionRadii(scene)).toEqual([4.5, 8]);
		scene.dynamics.collision = 1;
		expect(interactionRadii(scene)[0]).toBeCloseTo(5.4);
		expect(interactionRadii(scene)[1]).toBeCloseTo(9.6);
	});
	it('includes active metric response ranges and ignores inactive artistic rules', () => {
		const scene = createDefaultScene();
		const a = scene.species[0];
		a.metricRules = [
			{
				id: 'metric',
				metric: 'speed',
				role: 'self',
				range: [0, 4],
				curve: {
					points: [
						[0, 0],
						[1, 1]
					]
				},
				behavior: 'orbit',
				strength: 1,
				radius: 11
			}
		];
		expect(interactionRadii(scene)[0]).toBe(11);
		a.metricRules[0].strength = 0;
		expect(interactionRadii(scene)[0]).toBe(a.perception);
	});
});

it('keeps torus physical query, tube radius, major radius and embedded bounds distinct', () => {
	const scene = createDefaultScene();
	scene.world = { kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 };
	for (const species of scene.species) species.perception = 2;
	scene.speciesRules = [];
	const config = packConfig(scene, { population: 100, tick: 0, historyHead: 0, validHistory: 1 });
	expect(config[2]).toBe(4);
	expect(config[5]).toBe(8);
	expect(config[6]).toBe(2);
	expect(Array.from(config.subarray(8, 12))).toEqual([28, 8, 28, 0]);
	expect(config[22]).toBe(20);
});

it('packs exact identity words into a reusable subarray without overwriting its surroundings', () => {
	const scene = createDefaultScene();
	scene.seed = 0xffffffff;
	const backing = new Float32Array(100);
	backing.fill(19);
	const destination = backing.subarray(4, 76);
	packConfig(
		scene,
		{ population: 10, tick: 0x1000003, historyHead: 0, validHistory: 1, selectedId: 0xfffffffb },
		undefined,
		destination
	);
	expect(
		Array.from(
			new Uint32Array(destination.buffer, destination.byteOffset, destination.length).subarray(
				56,
				60
			)
		)
	).toEqual([0x1000003, 0xffffffff, 1, 0xfffffffb]);
	expect(backing[0]).toBe(19);
	expect(backing[76]).toBe(19);
});
