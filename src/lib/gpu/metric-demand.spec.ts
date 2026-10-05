import { describe, expect, it } from 'vitest';
import { createDefaultScene, curvePreset, METRICS } from '#lib/model';
import type { MetricRule } from '#lib/model';
import {
	ALL_METRICS_MASK,
	LOCAL_METRICS_MASK,
	metricBit,
	requiredMetricMask,
	BASIC_NEIGHBORHOOD_METRICS_MASK,
	usesBasicNeighborhoodMetrics
} from './metric-demand';
import { packConfig } from './packing';

describe('completed metric demand', () => {
	it('keeps the default turning appearance local without an unused neighborhood pass', () => {
		expect(requiredMetricMask(createDefaultScene())).toBe(LOCAL_METRICS_MASK);
	});

	it('uses the shared metric registry as the complete 15-bit layout', () => {
		expect(ALL_METRICS_MASK).toBe(32767);
		expect(METRICS.reduce((mask, metric) => mask | metricBit(metric.id), 0)).toBe(ALL_METRICS_MASK);
		METRICS.forEach((metric, index) => expect(metricBit(metric.id)).toBe(1 << index));
	});

	it('bounds the basic variant to its exact dependencies and requires a neighborhood consumer', () => {
		expect(BASIC_NEIGHBORHOOD_METRICS_MASK).toBe(351);
		for (const mask of [15, 23, 31, 71, 79, 87, 95, 271, 279, 327, 351])
			expect(usesBasicNeighborhoodMetrics(mask)).toBe(true);
		for (const mask of [0, 7, 263, ALL_METRICS_MASK])
			expect(usesBasicNeighborhoodMetrics(mask)).toBe(false);
		for (const definition of METRICS) {
			const bit = metricBit(definition.id);
			if ((bit & BASIC_NEIGHBORHOOD_METRICS_MASK) === 0) {
				expect(usesBasicNeighborhoodMetrics(71 | bit)).toBe(false);
				expect(usesBasicNeighborhoodMetrics(23 | bit)).toBe(false);
			}
		}
	});

	it('includes independent channels on every species and skips disabled or zero-strength channels', () => {
		const scene = createDefaultScene();
		scene.species[0].visual.hue = {
			...scene.species[0].visual.hue,
			enabled: true,
			source: 'anisotropy'
		};
		scene.species[1].visual.saturation = {
			...scene.species[1].visual.saturation,
			enabled: true,
			source: 'speed-contrast'
		};
		expect(requiredMetricMask(scene)).toBe(
			LOCAL_METRICS_MASK | metricBit('anisotropy') | metricBit('speed-contrast')
		);
		scene.species[0].visual.hue.enabled = false;
		scene.species[1].visual.saturation.strength = 0;
		expect(requiredMetricMask(scene)).toBe(LOCAL_METRICS_MASK);
	});

	it.each(['neighbor', 'self', 'difference'] as const)(
		'requests all species snapshots for the %s metric rule role',
		(role) => {
			const scene = createDefaultScene();
			scene.species[0].metricRules = [
				{
					id: 'observable',
					metric: 'radial-flow',
					role,
					behavior: 'flee',
					strength: 1,
					range: [-1, 1],
					radius: null,
					curve: curvePreset('linear')
				}
			];
			expect(requiredMetricMask(scene)).toBe(LOCAL_METRICS_MASK | metricBit('radial-flow'));
		}
	);

	it('matches the exact physical solver active-strength threshold and Ignore behavior', () => {
		const scene = createDefaultScene();
		const rule: MetricRule = {
			id: 'threshold',
			metric: 'density',
			role: 'neighbor',
			behavior: 'flee',
			strength: 1e-7,
			range: [0, 4],
			radius: null,
			curve: curvePreset('linear')
		};
		scene.species[0].metricRules = [rule];
		expect(requiredMetricMask(scene)).toBe(LOCAL_METRICS_MASK | metricBit('density'));
		rule.strength = -1e-7;
		expect(requiredMetricMask(scene)).toBe(LOCAL_METRICS_MASK | metricBit('density'));
		rule.strength = 0.999999e-7;
		expect(requiredMetricMask(scene)).toBe(LOCAL_METRICS_MASK);
		rule.strength = 0.9999999999e-7; // Packs to exactly the active WGSL threshold.
		expect(requiredMetricMask(scene)).toBe(LOCAL_METRICS_MASK | metricBit('density'));
		rule.strength = 1;
		rule.behavior = 'ignore';
		expect(requiredMetricMask(scene)).toBe(LOCAL_METRICS_MASK);
	});

	it('leaves diagnostic calls complete and lets the mounted engine explicitly request a mask', () => {
		const scene = createDefaultScene();
		const options = { population: 8, tick: 0, historyHead: 0, validHistory: 1 };
		expect(packConfig(scene, options)[13 * 4 + 3]).toBe(ALL_METRICS_MASK);
		expect(packConfig(scene, { ...options, metricMask: LOCAL_METRICS_MASK })[13 * 4 + 3]).toBe(
			LOCAL_METRICS_MASK
		);
	});
});
