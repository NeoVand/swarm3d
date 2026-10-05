import type { InspectionSample } from '#lib/gpu/contracts';
import type { Vec3, WorldDefinition } from '#lib/model/types';

/** Single-agent telemetry only; time is simulation time, never display or readback time. */
export const INSPECTION_WINDOW_SECONDS = 20;
export const INSPECTION_MAX_SAMPLES = 128;
export type InspectionHistory = readonly InspectionSample[];
export type InspectionMetric = 'speed' | 'turnRate' | 'acceleration' | 'neighbors';

function valid(sample: InspectionSample): boolean {
	return (
		Number.isFinite(sample.simulationTime) &&
		sample.simulationTime >= 0 &&
		Number.isSafeInteger(sample.tick) &&
		sample.tick >= 0 &&
		[sample.speed, sample.turnRate, sample.acceleration, sample.neighbors].every(Number.isFinite) &&
		sample.position.every(Number.isFinite) &&
		sample.velocity.every(Number.isFinite)
	);
}

/** Call with null at selection clear, reset/load, device replacement, or a new run generation. */
export function appendInspectionHistory(
	history: InspectionHistory,
	sample: InspectionSample | null
): InspectionHistory {
	if (!sample) return [];
	if (!valid(sample)) return history;
	const previous = history.at(-1);
	const changed =
		previous &&
		(previous.id !== sample.id ||
			previous.speciesKey !== sample.speciesKey ||
			sample.tick < previous.tick ||
			sample.simulationTime < previous.simulationTime);
	const retained = changed ? [] : history;
	// Own the vectors: neither a reusable readback array nor callers can rewrite past samples.
	const copy: InspectionSample = {
		...sample,
		position: [...sample.position],
		velocity: [...sample.velocity]
	};
	// Paused measurements may refresh a value, but never create extra history or elapsed time.
	if (retained.length && retained.at(-1)!.simulationTime === sample.simulationTime)
		return [...retained.slice(0, -1), copy];
	const window = [...retained, copy].filter(
		(entry) => entry.simulationTime >= sample.simulationTime - INSPECTION_WINDOW_SECONDS
	);
	// At slow playback, readbacks are dense in simulation time. Preserve the full
	// time window and both endpoints by discarding the most redundant interior
	// sample; every retained value is still an actual completed measurement.
	while (window.length > INSPECTION_MAX_SAMPLES) {
		let remove = 1;
		let narrowest = Infinity;
		for (let index = 1; index < window.length - 1; index++) {
			const span = window[index + 1].simulationTime - window[index - 1].simulationTime;
			if (span < narrowest) {
				narrowest = span;
				remove = index;
			}
		}
		window.splice(remove, 1);
	}
	return window;
}

export interface HistoryPoint {
	tick: number;
	x: number;
	y: number;
	value: number;
}

/** Do not draw a false long chord across a periodic seam, including a shorter box axis. */
export function inspectionSegmentCrossesSeam(world: WorldDefinition, from: Vec3, to: Vec3) {
	if (world.shape === 'box' && world.boundaries === 'periodic')
		return world.halfExtents.some((half, axis) => Math.abs(to[axis] - from[axis]) > half);
	if (world.shape === 'plane' && world.boundaries === 'periodic')
		return (
			Math.abs(to[0] - from[0]) > world.halfExtents[0] ||
			Math.abs(to[2] - from[2]) > world.halfExtents[1]
		);
	return false;
}

/** SVG coordinates keep uneven readback intervals faithful to physical elapsed time. */
export function inspectionCurve(
	history: InspectionHistory,
	metric: InspectionMetric,
	minimumCeiling: number,
	width = 240,
	height = 32
): { points: HistoryPoint[]; line: string; area: string; ceiling: number } {
	const end = history.at(-1)?.simulationTime ?? 0;
	const peak = Math.max(minimumCeiling, ...history.map((sample) => Math.max(0, sample[metric])));
	const magnitude = 10 ** Math.floor(Math.log10(Math.max(peak, 0.0001)));
	const ceiling = Math.ceil(peak / magnitude) * magnitude;
	const points = history.map((sample) => ({
		tick: sample.tick,
		value: sample[metric],
		x: Math.max(
			0,
			Math.min(width, width * (1 - (end - sample.simulationTime) / INSPECTION_WINDOW_SECONDS))
		),
		y: height - Math.max(0, Math.min(1, sample[metric] / ceiling)) * height
	}));
	const line = points
		.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
		.join(' ');
	const area = points.length
		? `${line} L${points.at(-1)!.x.toFixed(2)} ${height} L${points[0].x.toFixed(2)} ${height} Z`
		: '';
	return { points, line, area, ceiling };
}
