import { describe, expect, it } from 'vitest';
import { createDefaultScene, type WorldDefinition } from '#lib/model';
import { pickWorldRay, StageCamera } from './camera';

describe('camera framing is independent of the orbit pivot', () => {
	it('keeps the original world pivot and eye while panning, then rotates around that pivot', () => {
		const camera = new StageCamera(createDefaultScene().camera);
		camera.update(4 / 3);
		const target = [...camera.definition.target],
			eye = [...camera.position];
		camera.pan(120, -60, 600);
		camera.update(4 / 3);
		expect(camera.definition.target).toEqual(target);
		expect(camera.position).toEqual(eye);
		const framing = camera.project(camera.definition.target);
		expect(framing[0]).toBeCloseTo(0.3, 6);
		expect(framing[1]).toBeCloseTo(0.2, 6);
		camera.orbit(250, -80);
		camera.update(4 / 3);
		expect(camera.definition.target).toEqual(target);
		expect(camera.project(camera.definition.target)[0]).toBeCloseTo(framing[0], 6);
		expect(camera.project(camera.definition.target)[1]).toBeCloseTo(framing[1], 6);
		expect(Math.hypot(...camera.position.map((v, i) => v - target[i]))).toBeCloseTo(
			camera.definition.distance,
			10
		);
	});

	it('backs out projection pan for picking at different depths and camera angles', () => {
		const definition = createDefaultScene().camera;
		definition.target = [4, -2, 7];
		definition.pan = [0.64, -0.38];
		const camera = new StageCamera(definition);
		for (const aspect of [0.7, 1, 1.8]) {
			camera.orbit(70, 25);
			camera.update(aspect);
			for (const point of [
				[0, 0, 0],
				[4, -2, 7],
				[6, 3, -10]
			] as const) {
				const projected = camera.project(point);
				const ray = camera.ray(projected[0], projected[1]);
				const offset = point.map((v, i) => v - ray.origin[i]);
				const distance = Math.hypot(...offset);
				for (let axis = 0; axis < 3; axis++)
					expect(ray.direction[axis]).toBeCloseTo(offset[axis] / distance, 6);
			}
		}
	});

	it('retains a stable matrix binding without compounding pan on repeated updates', () => {
		const camera = new StageCamera({ ...createDefaultScene().camera, pan: [0.3, 0.1] });
		const binding = camera.update(1.5),
			initial = [...binding];
		for (let frame = 0; frame < 20; frame++) {
			expect(camera.update(1.5)).toBe(binding);
			expect([...binding]).toEqual(initial);
		}
	});

	it('keeps pan through zoom and autorotation and scales horizontal framing with aspect', () => {
		const camera = new StageCamera({
			...createDefaultScene().camera,
			pan: [0.5, -0.25],
			autoRotate: 0.08
		});
		camera.zoom(-200);
		camera.update(2, 3);
		const projected = camera.project(camera.definition.target);
		expect(projected[0]).toBeCloseTo(0.25, 6);
		expect(projected[1]).toBeCloseTo(-0.25, 6);
		camera.update(0.5);
		expect(camera.project(camera.definition.target)[0]).toBeCloseTo(1, 6);
		expect(camera.project(camera.definition.target)[1]).toBeCloseTo(-0.25, 6);
	});

	it('keeps legacy camera scenes centered without rewriting their explicit focus', () => {
		const definition = { ...createDefaultScene().camera, target: [2, 3, -1] as const };
		const camera = new StageCamera(definition);
		camera.update(1.25);
		expect(camera.definition.pan).toBeUndefined();
		expect(camera.project(definition.target)[0]).toBeCloseTo(0, 6);
		expect(camera.project(definition.target)[1]).toBeCloseTo(0, 6);
		expect(definition.target).toEqual([2, 3, -1]);
	});
});

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
