import { describe, expect, it } from 'vitest';
import type { InspectionSample } from '#lib/gpu/contracts';
import {
	appendInspectionHistory,
	inspectionCurve,
	inspectionSegmentCrossesSeam,
	INSPECTION_MAX_SAMPLES,
	type InspectionHistory
} from './inspection-history';

function sample(time: number, changes: Partial<InspectionSample> = {}): InspectionSample {
	return {
		id: 42,
		speciesKey: 'jade',
		position: [1, 2, 3],
		velocity: [3, 0, 0],
		speed: 3,
		turnRate: 0.2,
		acceleration: 0.3,
		neighbors: 7,
		density: 1,
		structure: 0.4,
		simulationTime: time,
		tick: Math.round(time * 60),
		...changes
	};
}

describe('single-agent inspection history', () => {
	it('does not accumulate paused samples, while allowing measurement refresh', () => {
		let history = appendInspectionHistory([], sample(4));
		for (let i = 0; i < 30; i++)
			history = appendInspectionHistory(history, sample(4, { neighbors: i }));
		expect(history).toHaveLength(1);
		expect(history[0].neighbors).toBe(29);
		expect(history[0].simulationTime).toBe(4);
	});
	it('clears on selection, explicit generation reset, and simulation time rewind', () => {
		const history = appendInspectionHistory([], sample(12));
		expect(appendInspectionHistory(history, sample(13, { id: 7 }))).toEqual([
			sample(13, { id: 7 })
		]);
		expect(appendInspectionHistory(history, sample(13, { speciesKey: 'amber' }))).toHaveLength(1);
		expect(appendInspectionHistory(history, null)).toEqual([]);
		expect(appendInspectionHistory(history, sample(0))).toEqual([sample(0)]);
	});
	it('bounds both physical history time and sample count', () => {
		let history: InspectionHistory = [];
		for (let i = 0; i <= 200; i++) history = appendInspectionHistory(history, sample(i / 4));
		expect(history.at(-1)?.simulationTime).toBe(50);
		expect(history[0].simulationTime).toBe(30);
		expect(history).toHaveLength(81);
		for (let i = 0; i < 1000; i++)
			history = appendInspectionHistory(history, sample(50 + (i + 1) / 60));
		expect(history).toHaveLength(INSPECTION_MAX_SAMPLES);
		expect(history.at(-1)?.simulationTime).toBeCloseTo(50 + 1000 / 60);
		expect(history[0].simulationTime).toBeGreaterThanOrEqual(50 + 1000 / 60 - 20);
		expect(history[0].simulationTime).toBeLessThan(48);
	});
	it('owns vector snapshots and leaves existing history immutable', () => {
		const position: [number, number, number] = [1, 2, 3];
		const first = appendInspectionHistory([], sample(1, { position }));
		position[0] = 100;
		const next = appendInspectionHistory(first, sample(2));
		expect(first).toHaveLength(1);
		expect(first[0].position[0]).toBe(1);
		expect(next).toHaveLength(2);
	});
	it('rejects invalid telemetry instead of creating invalid paths', () => {
		const history = appendInspectionHistory([], sample(1));
		for (const invalid of [
			sample(NaN),
			sample(2, { speed: Infinity }),
			sample(2, { position: [NaN, 0, 0] })
		])
			expect(appendInspectionHistory(history, invalid)).toBe(history);
	});
	it('places unevenly sampled measurements using simulation time', () => {
		const curve = inspectionCurve([sample(0), sample(5), sample(20)], 'speed', 4, 200, 32);
		expect(curve.points.map((point) => point.x)).toEqual([0, 50, 200]);
		expect(curve.points.map((point) => point.y)).toEqual([8, 8, 8]);
		expect(curve.ceiling).toBe(4);
	});
	it('keeps zero and empty histories finite without fabricating measurements', () => {
		expect(inspectionCurve([], 'neighbors', 1).points).toEqual([]);
		const zero = inspectionCurve([sample(0, { neighbors: 0 })], 'neighbors', 1);
		expect(zero.ceiling).toBe(1);
		expect(zero.points[0].y).toBe(32);
		expect(zero.line).not.toMatch(/NaN|Infinity/);
	});
	it('breaks trajectory lines at every periodic axis without inventing reflecting seams', () => {
		const box = {
			kind: 'volume',
			shape: 'box',
			halfExtents: [18, 4, 18],
			boundaries: 'periodic'
		} as const;
		expect(inspectionSegmentCrossesSeam(box, [0, 3.9, 0], [0, -3.9, 0])).toBe(true);
		expect(inspectionSegmentCrossesSeam(box, [17.9, 0, 0], [-17.9, 0, 0])).toBe(true);
		expect(
			inspectionSegmentCrossesSeam({ ...box, boundaries: 'reflect' }, [0, 3.9, 0], [0, -3.9, 0])
		).toBe(false);
		expect(
			inspectionSegmentCrossesSeam(
				{ kind: 'surface', shape: 'plane', halfExtents: [18, 4], boundaries: 'periodic' },
				[0, 0, 3.9],
				[0, 0, -3.9]
			)
		).toBe(true);
		expect(inspectionSegmentCrossesSeam(box, [0, 0, 0], [1, 1, 1])).toBe(false);
	});
});
