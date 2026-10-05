import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '#lib/model';
import {
	counterpartShape,
	VOLUME_SHAPES,
	SURFACE_SHAPES,
	worldForChoice,
	worldControlBounds
} from './world-selection';
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
			'torus',
			'mobius',
			'klein',
			'projective',
			'trefoil'
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

	it.each(['mobius', 'klein', 'projective', 'trefoil'] as const)(
		'keeps %s scale and selects a valid volume counterpart',
		(shape) => {
			const world: WorldDefinition = { kind: 'surface', shape, radius: 27 };
			expect(worldForChoice(world, 'surface', shape)).toEqual(world);
			expect(worldForChoice(world, 'surface', shape)).not.toBe(world);
			expect(counterpartShape(world, 'volume')).toBe('sphere');
			expect(worldForChoice(world, 'volume', counterpartShape(world, 'volume'))).toEqual({
				kind: 'volume',
				shape: 'sphere',
				radius: 27
			});
			expect(() => worldForChoice(world, 'volume', shape)).toThrow(RangeError);
			expect(worldHelp(world).description).not.toContain('sphere');
		}
	);

	it('opens trefoil controls with a physical tube radius and preserves an edited thickness', () => {
		const sphere: WorldDefinition = { kind: 'surface', shape: 'sphere', radius: 20 };
		expect(worldForChoice(sphere, 'surface', 'trefoil')).toEqual({
			kind: 'surface',
			shape: 'trefoil',
			radius: 20,
			tubeRadius: 3
		});
		const trefoil: WorldDefinition = {
			kind: 'surface',
			shape: 'trefoil',
			radius: 20,
			tubeRadius: 1.6
		};
		expect(worldForChoice(trefoil, 'surface', 'trefoil')).toEqual(trefoil);
		expect(worldForChoice(trefoil, 'surface', 'trefoil')).not.toBe(trefoil);
		expect(worldForChoice(trefoil, 'volume', 'sphere')).toEqual({
			kind: 'volume',
			shape: 'sphere',
			radius: 20
		});
		expect(worldHelp(trefoil).geometry).toContain('tube radius 1.6 u');
	});

	it('uses conservative constant-time bounds for surface controls', () => {
		expect(
			worldControlBounds({ kind: 'surface', shape: 'trefoil', radius: 20, tubeRadius: 1.6 })
		).toEqual([20, 20, 20]);
		expect(worldControlBounds({ kind: 'surface', shape: 'klein', radius: 14 })).toEqual([
			14, 14, 14
		]);
		expect(
			worldControlBounds({
				kind: 'volume',
				shape: 'box',
				halfExtents: [18, 12, 18],
				boundaries: 'reflect'
			})
		).toEqual([18, 12, 18]);
		expect(
			worldControlBounds({
				kind: 'surface',
				shape: 'plane',
				halfExtents: [18, 24],
				boundaries: 'reflect'
			})
		).toEqual([18, 0, 24]);
	});

	it('restores the sphere default when changing from another analytic shape', () => {
		const cylinder: WorldDefinition = {
			kind: 'surface',
			shape: 'cylinder',
			radius: 12.5,
			halfHeight: 14
		};
		expect(worldForChoice(cylinder, 'surface', 'sphere')).toEqual({
			kind: 'surface',
			shape: 'sphere',
			radius: 14
		});
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
