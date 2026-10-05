import { describe, expect, it } from 'vitest';
import { createDefaultScene } from '#lib/model/defaults';
import { linearBackground, stageBackground } from './appearance';

describe('stage appearance', () => {
	it('preserves a chosen night background across a day-mode round trip', () => {
		const visual = { ...createDefaultScene().visual, background: '#224466' };
		expect(stageBackground(visual)).toBe('#224466');
		expect(stageBackground({ ...visual, theme: 'day' })).toBe('#e7eff3');
		expect(stageBackground({ ...visual, theme: 'night' })).toBe('#224466');
	});
	it('converts the presentation background from sRGB to linear light once', () => {
		const visual = { ...createDefaultScene().visual, background: '#0080ff' };
		const [black, midpoint, white] = linearBackground(visual);
		expect(black).toBe(0);
		expect(midpoint).toBeCloseTo(0.2158605, 6);
		expect(white).toBe(1);
	});
});
