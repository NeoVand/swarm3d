import type { WorldDefinition } from '#lib/model';

export const SURFACE_SHAPES = [
	{ value: 'sphere', label: 'Sphere' },
	{ value: 'plane', label: 'Plane' },
	{ value: 'cylinder', label: 'Cylinder' },
	{ value: 'torus', label: 'Torus' }
] as const;

export function worldHelp(world: WorldDefinition) {
	switch (world.shape) {
		case 'box':
			return {
				title: 'Three-dimensional volume',
				description: 'Agents move freely in a box.',
				distance: 'Euclidean distance in the volume.',
				physics:
					'Neighbors use three-dimensional distance. The box can reflect agents or wrap periodically.',
				geometry:
					'Reflecting walls bounce agents. Periodic boundaries join opposite faces while preserving motion.'
			};
		case 'sphere':
			return {
				title: 'Spherical surface',
				description: 'Agents move on a curved, closed surface.',
				distance: 'Arc distance along the sphere.',
				physics:
					'Velocities remain tangent. Neighbor velocities are parallel transported before comparison.',
				geometry:
					'The sphere has no boundary. Distances measure arcs; interaction ranges stay below a quarter of a great circle to keep the local query unique.'
			};
		case 'plane':
			return {
				title: 'Plane surface',
				description: 'Agents move across a flat, horizontal surface.',
				distance:
					'Distance in the XZ plane, using the shortest wrapped displacement for periodic edges.',
				physics: 'Motion stays in the XZ plane. This surface has an exact flat metric.',
				geometry:
					world.boundaries === 'periodic'
						? 'Opposite edges are joined. Neighbors use the shortest wrapped displacement; trails split at the visible edges.'
						: 'The four edges reflect agents. Width and depth set the physical dimensions, independently of the camera.'
			};
		case 'cylinder':
			return {
				title: 'Cylinder surface',
				description: 'Agents move around an open cylinder with reflecting ends.',
				distance: 'Exact unrolled distance: circular arc length combined with axial distance.',
				physics:
					'The circular seam preserves tangent motion and parallel transport. The axial ends reflect agents.',
				geometry:
					'Unroll the cylinder to get its exact flat metric. Interaction ranges stay below half its circumference; the visible shell is open at both ends.'
			};
		case 'torus':
			return {
				title: 'Torus surface',
				description: 'Agents follow a curved, closed tube around a central opening.',
				distance:
					'Symmetric local midpoint distance estimate on the curved surface, within 0.3 times the tube radius.',
				physics:
					'Motion and transport use the metric of the visible torus. Neighbor distances are local estimates, not global shortest paths.',
				geometry: `Local queries stay below ${(world.tubeRadius * 0.3).toLocaleString(undefined, { maximumFractionDigits: 2 })} u (0.3 × tube radius). The midpoint approximation’s CPU audit found a largest measured distance error of 0.125%; this is sampled evidence, not a global error guarantee.`
			};
	}
}
