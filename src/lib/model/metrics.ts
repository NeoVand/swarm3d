import type { AgentMetrics, ChannelMap, MetricDefinition, MetricId } from '#lib/model/types';
import { evaluateCurve } from '#lib/model/curves';

const definitions: readonly Omit<MetricDefinition, 'temporal' | 'accuracy'>[] = [
	{
		id: 'speed',
		label: 'Speed',
		unit: 'units/s',
		description: 'Physical velocity magnitude.',
		range: [0, 8]
	},
	{
		id: 'turn-rate',
		label: 'Turning',
		unit: 'rad/s',
		description:
			'Heading change per second after parallel transport on a surface; zero without velocity history.',
		range: [0, Math.PI]
	},
	{
		id: 'acceleration',
		label: 'Acceleration',
		unit: 'units/s²',
		description: 'Velocity change per second after parallel transport, not a turning proxy.',
		range: [0, 12]
	},
	{
		id: 'neighbor-count',
		label: 'Neighbors',
		unit: 'agents',
		description: 'All other agents within this species’ perception radius.',
		range: [0, 100]
	},
	{
		id: 'density',
		label: 'Density',
		unit: 'agents/unit³',
		surfaceUnit: 'agents/unit²',
		description:
			'Neighbor count divided by nominal ball volume, spherical-cap area, or πr² disk area for plane/cylinder/torus. Torus neighbors use the local midpoint metric; no curvature or boundary correction.',
		range: [0, 4]
	},
	{
		id: 'anisotropy',
		label: 'Anisotropy',
		unit: 'ratio',
		description:
			'Normalized principal concentration of displacement second moments: 0 isotropic, 1 line-like; a uniform 3D sheet is 0.25.',
		range: [0, 1]
	},
	{
		id: 'polarization',
		label: 'Alignment',
		unit: 'ratio',
		description:
			'Magnitude of the mean unit neighbor velocity, transported into the observing tangent plane.',
		range: [0, 1]
	},
	{
		id: 'radial-flow',
		label: 'Radial flow',
		unit: 'ratio',
		description:
			'Mean radial component of normalized relative neighbor velocity; positive means moving apart.',
		range: [-1, 1]
	},
	{
		id: 'heading-azimuth',
		label: 'World heading',
		unit: 'turns',
		description:
			'Velocity azimuth in the world XZ plane. Zero for a vertical or stationary velocity; this reference is not rotation invariant.',
		range: [0, 1],
		circular: true
	},
	{
		id: 'center-distance',
		label: 'Center distance',
		unit: 'units',
		description: 'Length of the mean intrinsic neighbor displacement.',
		range: [0, 6]
	},
	{
		id: 'center-bearing',
		label: 'Center bearing',
		unit: 'turns',
		description:
			'Bearing of mean displacement in the local oriented frame; zero for zero displacement. Sphere references world Y with a pole fallback; torus uses continuous negative-azimuth/tube axes.',
		range: [0, 1],
		circular: true
	},
	{
		id: 'flow-orbit',
		label: 'Flow bearing',
		unit: 'turns',
		description:
			'Bearing of mean transported neighbor velocity in the local oriented frame, rather than numerical divergence.',
		range: [0, 1],
		circular: true
	},
	{
		id: 'center-orbit-angle',
		label: 'Orbit angle',
		unit: 'turns',
		description:
			'Velocity angle relative to the outward local-center direction, oriented around the surface normal or configured volume orbit axis. Outward motion is 0.5 turns, inward is 0; zero when either projected direction vanishes.',
		range: [0, 1],
		circular: true
	},
	{
		id: 'center-radial-speed',
		label: 'Radial speed',
		unit: 'units/s',
		description:
			'Signed component of this agent’s velocity toward its neighborhood center; positive approaches the center, negative moves away.',
		range: [-8, 8]
	},
	{
		id: 'speed-contrast',
		label: 'Speed contrast',
		unit: 'ratio',
		description:
			'Absolute difference between this agent’s speed and the magnitude of the mean transported neighbor velocity, divided by its species speed limit. Zero without neighbors.',
		range: [0, 1]
	}
];
export const METRICS: readonly MetricDefinition[] = definitions.map((definition) => ({
	...definition,
	temporal: ['speed', 'neighbor-count', 'density'].includes(definition.id) ? 'instant' : 'smoothed',
	accuracy: ['speed', 'neighbor-count', 'heading-azimuth'].includes(definition.id)
		? 'exact'
		: 'local-estimate',
	description:
		definition.description +
		(['speed', 'neighbor-count', 'density'].includes(definition.id)
			? ''
			: ' The reported value follows the scene’s temporal smoothing setting.')
}));
export const METRIC_IDS = METRICS.map((metric) => metric.id);
export const METRIC_FIELDS: Record<MetricId, keyof AgentMetrics> = {
	speed: 'speed',
	'turn-rate': 'turnRate',
	acceleration: 'acceleration',
	'neighbor-count': 'neighborCount',
	density: 'density',
	anisotropy: 'anisotropy',
	polarization: 'polarization',
	'radial-flow': 'radialFlow',
	'heading-azimuth': 'headingAzimuth',
	'center-distance': 'centerDistance',
	'center-bearing': 'centerBearing',
	'flow-orbit': 'flowOrbit',
	'center-orbit-angle': 'centerOrbitAngle',
	'center-radial-speed': 'centerRadialSpeed',
	'speed-contrast': 'speedContrast'
};
export function metricDefinition(id: MetricId): MetricDefinition {
	const definition = METRICS.find((metric) => metric.id === id);
	if (!definition) throw new Error(`Unknown metric: ${id}`);
	return definition;
}
export function metricValue(metrics: AgentMetrics, id: MetricId): number {
	return metrics[METRIC_FIELDS[id]];
}
export function metricDifference(id: MetricId, a: number, b: number): number {
	const difference = Math.abs(a - b);
	if (!metricDefinition(id).circular) return difference;
	const wrapped = difference % 1;
	return Math.min(wrapped, 1 - wrapped);
}
export function mapChannel(channel: ChannelMap, metrics: AgentMetrics, base: number): number {
	if (!channel.enabled || channel.source === 'constant') return base;
	const [low, high] = channel.range;
	const mapped = evaluateCurve(
		channel.curve,
		Math.max(0, Math.min(1, (metricValue(metrics, channel.source) - low) / (high - low)))
	);
	return base + (mapped - base) * channel.strength;
}

export const PALETTES = [
	{ id: 'chrome', name: 'Chrome', colors: ['#cbd5e1', '#f8fafc', '#64748b'] },
	{ id: 'ocean', name: 'Ocean', colors: ['#075985', '#38bdf8', '#99f6e4'] },
	{ id: 'bands', name: 'Bands', colors: ['#fb7185', '#fbbf24', '#a3e635', '#38bdf8'] },
	{
		id: 'rainbow',
		name: 'Rainbow',
		colors: ['#fb7185', '#fbbf24', '#34d399', '#60a5fa', '#c084fc']
	},
	{ id: 'mono', name: 'Mono', colors: ['#334155', '#94a3b8', '#f1f5f9'] }
] as const;
