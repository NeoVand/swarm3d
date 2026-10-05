import type { WorldDefinition } from '#lib/model';

export const VOLUME_SHAPES = [
	{ value: 'box', label: 'Box' },
	{ value: 'sphere', label: 'Sphere' },
	{ value: 'cylinder', label: 'Cylinder' },
	{ value: 'torus', label: 'Torus' }
] as const;

export const SURFACE_SHAPES = [
	{ value: 'sphere', label: 'Sphere' },
	{ value: 'plane', label: 'Plane' },
	{ value: 'cylinder', label: 'Cylinder' },
	{ value: 'torus', label: 'Torus' }
] as const;

/** Keep the same visible geometry when it has a counterpart in the other domain. */
export function counterpartShape(world: WorldDefinition, kind: WorldDefinition['kind']) {
	if (kind === 'surface' && world.shape === 'box') return 'sphere';
	if (kind === 'volume' && world.shape === 'plane') return 'box';
	return world.shape;
}

export function worldForChoice(
	current: WorldDefinition,
	kind: WorldDefinition['kind'],
	shape: WorldDefinition['shape']
): WorldDefinition {
	if ((kind === 'volume' && shape === 'plane') || (kind === 'surface' && shape === 'box'))
		throw new RangeError(`${shape} is not available in the ${kind} domain`);
	if (current.kind === kind && current.shape === shape) return structuredClone(current);
	if (shape === 'box')
		return {
			kind: 'volume',
			shape,
			halfExtents:
				current.shape === 'plane'
					? [current.halfExtents[0], 12, current.halfExtents[1]]
					: [18, 12, 18],
			boundaries: current.shape === 'plane' ? current.boundaries : 'reflect'
		};
	if (shape === 'plane')
		return { kind: 'surface', shape, halfExtents: [18, 18], boundaries: 'reflect' };
	if (shape === 'sphere')
		return { kind, shape, radius: current.shape === shape ? current.radius : 14 };
	if (shape === 'cylinder')
		return {
			kind,
			shape,
			radius: current.shape === shape ? current.radius : 12,
			halfHeight: current.shape === shape ? current.halfHeight : 14
		};
	return {
		kind,
		shape: 'torus',
		majorRadius: current.shape === 'torus' ? current.majorRadius : 20,
		tubeRadius: current.shape === 'torus' ? current.tubeRadius : 8
	};
}
