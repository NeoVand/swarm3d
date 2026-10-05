import { describe, expect, it } from 'vitest';
import { createDefaultScene, initializePopulation } from '#lib/model';
import { trailQuadIndices, trailSegmentCount, trailSpeciesRanges } from './trail-render';

describe('indexed world-space trails', () => {
	it('keeps species draw ranges aligned with actual particle slots across UI order changes', () => {
		const scene = createDefaultScene();
		scene.species[0].population = 7;
		scene.species[1].population = 3;
		const population = initializePopulation(scene);
		for (const order of [scene.species, [...scene.species].reverse()]) {
			const ranges = trailSpeciesRanges({ ...scene, species: order });
			expect(ranges.reduce((count, range) => count + range.instances, 0)).toBe(10);
			for (const range of ranges)
				expect(
					population.agents
						.slice(range.firstInstance, range.firstInstance + range.instances)
						.every((agent) => agent.speciesKey === range.key)
				).toBe(true);
		}
	});

	it('bounds each species by its own physical trail length and completed history', () => {
		expect(trailSegmentCount(1.4, 1 / 30, 0.018, 64)).toBe(43);
		expect(trailSegmentCount(0.7, 1 / 30, 0.018, 64)).toBe(22);
		expect(trailSegmentCount(1.4, 1 / 30, 0.018, 3)).toBe(3);
		expect(trailSegmentCount(20, 1 / 60, 0, 64)).toBe(63);
		expect(trailSegmentCount(0.01, 1 / 30, 0.02, 64)).toBe(1);
		expect(trailSegmentCount(0, 1 / 30, 0, 64)).toBe(0);
	});

	it('references precisely four vertices per segment with the original triangle winding', () => {
		const indices = trailQuadIndices();
		expect(indices.byteLength).toBe(756);
		expect([...indices.slice(0, 12)]).toEqual([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
		expect(Math.max(...indices)).toBe(251);
		for (let segment = 0; segment < 63; segment++) {
			const quad = [...indices.slice(segment * 6, segment * 6 + 6)];
			expect(new Set(quad).size).toBe(4);
			expect(quad.every((index) => Math.floor(index / 4) === segment)).toBe(true);
		}
	});
});
