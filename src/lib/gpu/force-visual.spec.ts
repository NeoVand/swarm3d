import { describe, expect, it } from 'vitest';
import { createDefaultScene } from '#lib/model';
import { forceVisualStyle } from './force-visual';

describe('honest field intent', () => {
	it('shows attract, repel and independent vortex intentions with distinct colors', () => {
		const scene = createDefaultScene();
		scene.species.forEach((species) => {
			species.cursor.response = 'attract';
			species.cursor.vortex = 0;
		});
		const attract = forceVisualStyle(scene);
		scene.species.forEach((species) => {
			species.cursor.response = 'repel';
		});
		const repel = forceVisualStyle(scene);
		scene.species.forEach((species) => {
			species.cursor.response = 'ignore';
			species.cursor.vortex = 1;
		});
		const vortex = forceVisualStyle(scene);
		expect(attract.intent[0]).toBe(1);
		expect(repel.intent[0]).toBe(-1);
		expect(vortex.intent.slice(0, 2)).toEqual([0, 1]);
		expect(new Set([attract, repel, vortex].map((style) => style.color.join(','))).size).toBe(3);
	});
	it('weights opposing responses by population and excludes ignored radial strengths', () => {
		const scene = createDefaultScene();
		const [a, b] = scene.species;
		a.population = b.population = 500;
		a.cursor = { response: 'attract', strength: 1, vortex: 0 };
		b.cursor = { response: 'repel', strength: 1, vortex: 0 };
		expect(forceVisualStyle(scene).intent[0]).toBe(0);
		b.cursor.response = 'ignore';
		b.cursor.strength = 10;
		expect(forceVisualStyle(scene).intent[0]).toBe(1);
	});
	it('keeps disabled and zero-power placement visible but inactive', () => {
		const scene = createDefaultScene();
		scene.forces.enabled = false;
		expect(forceVisualStyle(scene).color[3]).toBe(0);
		scene.forces.enabled = true;
		scene.forces.power = 0;
		expect(forceVisualStyle(scene).color[3]).toBe(0);
	});
});
