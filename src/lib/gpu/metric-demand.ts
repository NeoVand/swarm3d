import { METRICS } from '#lib/model/metrics';
import type { MetricId, SceneDefinition } from '#lib/model/types';

/** Bit order is the shared registry / 64-byte GPU Metrics layout. */
export const ALL_METRICS_MASK = (1 << METRICS.length) - 1;
export const LOCAL_METRICS_MASK = 0b111;

export function metricBit(id: MetricId): number {
	return 1 << METRICS.findIndex((definition) => definition.id === id);
}

/** One fixed variant omits centroid/covariance/radial-flow dependencies. */
export const BASIC_NEIGHBORHOOD_METRICS_MASK =
	LOCAL_METRICS_MASK |
	metricBit('neighbor-count') |
	metricBit('density') |
	metricBit('polarization') |
	metricBit('heading-azimuth');

export function usesBasicNeighborhoodMetrics(mask: number): boolean {
	const neighborhood =
		metricBit('neighbor-count') | metricBit('density') | metricBit('polarization');
	return (mask & neighborhood) !== 0 && (mask & ~BASIC_NEIGHBORHOOD_METRICS_MASK) === 0;
}

/**
 * A global union is deliberate: Neighbor and Difference rules can consume any
 * species' completed measurements, including species with no rules of their own.
 * Inspection adds all fields only for the selected stable identity in the shader.
 */
export function requiredMetricMask(scene: SceneDefinition): number {
	let mask = LOCAL_METRICS_MASK;
	for (const species of scene.species) {
		for (const channel of [
			species.visual.hue,
			species.visual.saturation,
			species.visual.lightness
		]) {
			if (channel.enabled && channel.source !== 'constant' && Math.fround(channel.strength) > 0)
				mask |= metricBit(channel.source);
		}
		for (const rule of species.metricRules) {
			// Match the physical solver's inclusive active-strength threshold.
			if (rule.behavior !== 'ignore' && Math.abs(Math.fround(rule.strength)) >= Math.fround(1e-7))
				mask |= metricBit(rule.metric);
		}
	}
	return mask;
}
