import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '#lib/model';
import { pickWorldRay } from './camera';

describe('surface picking follows visible geometry', () => {
	const plane: WorldDefinition = {
		kind: 'surface',
		shape: 'plane',
		halfExtents: [4, 3],
		boundaries: 'reflect'
	};
	const cylinder: WorldDefinition = {
		kind: 'surface',
		shape: 'cylinder',
		radius: 2,
		halfHeight: 3
	};
	it('hits the bounded plane regardless of the volume work plane and rejects outside points', () => {
		expect(pickWorldRay(plane, [1, 5, 2], [0, -1, 0], [1, 0, 0], 8)).toEqual({
			position: [1, 0, 2],
			normal: [0, 1, 0]
		});
		expect(pickWorldRay(plane, [5, 5, 2], [0, -1, 0])).toBeNull();
		expect(pickWorldRay(plane, [1, 5, 2], [1, 0, 0])).toBeNull();
	});
	it('selects the nearest cylinder side and supplies its radial normal', () => {
		expect(pickWorldRay(cylinder, [0, 1, 6], [0, 0, -1])).toEqual({
			position: [0, 1, 2],
			normal: [0, 0, 1]
		});
		expect(pickWorldRay(cylinder, [0, 4, 6], [0, 0, -1])).toBeNull();
	});
	it('does not invent closed cylinder end caps, and permits a ray starting inside', () => {
		expect(pickWorldRay(cylinder, [0, 8, 0], [0, -1, 0])).toBeNull();
		expect(pickWorldRay(cylinder, [0, 0, 0], [1, 0, 0])).toEqual({
			position: [2, 0, 0],
			normal: [1, 0, 0]
		});
	});
	it('keeps sphere and volume work-plane picking compatible', () => {
		expect(
			pickWorldRay({ kind: 'surface', shape: 'sphere', radius: 2 }, [0, 0, 6], [0, 0, -1])
		).toEqual({ position: [0, 0, 2], normal: [0, 0, 1] });
		const box: WorldDefinition = {
			kind: 'volume',
			shape: 'box',
			halfExtents: [4, 3, 5],
			boundaries: 'reflect'
		};
		expect(pickWorldRay(box, [0, 6, 0], [0, -1, 0], [0, 1, 0], 1)).toEqual({
			position: [0, 1, 0],
			normal: null
		});
	});
	it('finds the nearest torus wall while keeping the central hole open', () => {
		const torus: WorldDefinition = {
			kind: 'surface',
			shape: 'torus',
			majorRadius: 6,
			tubeRadius: 2
		};
		expect(pickWorldRay(torus, [0, 12, 0], [0, -1, 0])).toBeNull();
		const outer = pickWorldRay(torus, [0, 0, 12], [0, 0, -2])!;
		expect(outer.position[2]).toBeCloseTo(8, 8);
		expect(outer.normal![2]).toBeCloseTo(1, 8);
		const inner = pickWorldRay(torus, [0, 0, 0], [0, 0, 1])!;
		expect(inner.position[2]).toBeCloseTo(4, 8);
		expect(inner.normal![2]).toBeCloseTo(-1, 8);
		const insideTube = pickWorldRay(torus, [0, 0, 6], [0, 1, 0])!;
		expect(insideTube.position[1]).toBeCloseTo(2, 8);
		expect(insideTube.normal![1]).toBeCloseTo(1, 8);
		expect(pickWorldRay(torus, [0, 0, 12], [0, 0, 1])).toBeNull();
	});
	it('retains torus tangent hits and rejects a ray just outside the tube', () => {
		const torus: WorldDefinition = {
			kind: 'surface',
			shape: 'torus',
			majorRadius: 6,
			tubeRadius: 2
		};
		const tangent = pickWorldRay(torus, [6, 2, 10], [0, 0, -1])!;
		expect(tangent.position[2]).toBeCloseTo(0, 4);
		expect(tangent.normal![1]).toBeCloseTo(1, 7);
		expect(pickWorldRay(torus, [6, 2.001, 10], [0, 0, -1])).toBeNull();
	});
});
