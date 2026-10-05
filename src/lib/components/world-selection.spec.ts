import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '#lib/model';
import { counterpartShape, VOLUME_SHAPES, SURFACE_SHAPES, worldForChoice } from './world-selection';
import { worldHelp } from './world-help';

describe('graphical world choices', () => {
	it('offers filled curved volumes and only valid surface counterparts', () => {
		expect(VOLUME_SHAPES.map((shape) => shape.value)).toEqual([
			'box',
			'sphere',
			'cylinder',
			'torus'
		]);
		expect(SURFACE_SHAPES.map((shape) => shape.value)).toEqual([
			'sphere',
			'plane',
			'cylinder',
			'torus'
		]);
		const box = {
			kind: 'volume',
			shape: 'box',
			halfExtents: [21, 12, 32],
			boundaries: 'periodic'
		} as const;
		expect(counterpartShape(box, 'surface')).toBe('sphere');
		expect(() => worldForChoice(box, 'volume', 'plane')).toThrow(RangeError);
		expect(() => worldForChoice(box, 'surface', 'box')).toThrow(RangeError);
	});

	it.each<WorldDefinition>([
		{ kind: 'surface', shape: 'sphere', radius: 27 },
		{ kind: 'surface', shape: 'cylinder', radius: 19, halfHeight: 24 },
		{ kind: 'surface', shape: 'torus', majorRadius: 38, tubeRadius: 12 }
	])('preserves $shape dimensions while changing physical domain', (world) => {
		const volume = worldForChoice(world, 'volume', counterpartShape(world, 'volume'));
		expect(volume).toEqual({ ...world, kind: 'volume' });
		expect(worldForChoice(volume, 'surface', counterpartShape(volume, 'surface'))).toEqual(world);
		expect(worldHelp(volume).distance).toContain('Euclidean');
		expect(worldHelp(volume).description).toContain('inside');
		expect(worldHelp(world).description).not.toContain('inside');
	});

	it('keeps a plane’s horizontal extents and boundary mode when opening its volume counterpart', () => {
		const plane = {
			kind: 'surface',
			shape: 'plane',
			halfExtents: [23, 31],
			boundaries: 'periodic'
		} as const;
		expect(worldForChoice(plane, 'volume', counterpartShape(plane, 'volume'))).toEqual({
			kind: 'volume',
			shape: 'box',
			halfExtents: [23, 12, 31],
			boundaries: 'periodic'
		});
	});

	it('returns an independent configuration for a selected world', () => {
		const box: WorldDefinition = {
			kind: 'volume',
			shape: 'box',
			halfExtents: [18, 12, 18],
			boundaries: 'reflect'
		};
		const copy = worldForChoice(box, 'volume', 'box');
		expect(copy).toEqual(box);
		expect(copy).not.toBe(box);
		if (copy.shape === 'box') expect(copy.halfExtents).not.toBe(box.halfExtents);
	});
});
