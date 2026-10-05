import type { WorldDefinition } from '#lib/model';

export function worldHelp(world: WorldDefinition) {
	if (world.kind === 'volume' && world.shape !== 'box') {
		const shape = world.shape === 'torus' ? 'solid torus' : world.shape;
		return {
			title: `${world.shape[0].toUpperCase() + world.shape.slice(1)} volume`,
			description: `Agents move freely inside a ${shape}.`,
			distance: 'Euclidean distance through the three-dimensional volume.',
			physics:
				'Neighbors use complete three-dimensional radius queries. Motion reflects at the enclosing wall.',
			geometry:
				world.shape === 'sphere'
					? 'Positions fill the sphere, rather than its skin. The curved wall reflects motion; there are no surface arc distances.'
					: world.shape === 'cylinder'
						? 'A solid cylinder with a curved wall and closed reflecting ends. The camera can move inside to explore the volume.'
						: 'A solid doughnut: agents fill the tube and reflect from its curved wall. The central opening remains empty. Neighbors use direct spatial distance.'
		};
	}
	if (
		world.kind === 'surface' &&
		(world.shape === 'mobius' ||
			world.shape === 'klein' ||
			world.shape === 'projective' ||
			world.shape === 'trefoil')
	) {
		const descriptions = {
			mobius: {
				title: 'Möbius strip',
				description: 'A half-twisted ribbon with one side and one continuous edge.',
				geometry:
					'The seam reverses orientation; the physical edge reflects agents. Motion follows the visible triangulated ribbon.'
			},
			klein: {
				title: 'Klein bottle',
				description: 'A one-sided bottle whose neck bends through its body.',
				geometry:
					'The classic Dickson immersion from Swarm stands upright, with its neck returning through the bulb. Its original piecewise join is retained in the triangle surface. Intersecting sheets stay independent: agents, forces, and obstacles follow their connected surface.'
			},
			projective: {
				title: 'Projective plane',
				description: 'A one-sided, closed surface shown as a Roman surface.',
				geometry:
					'Antipodal points are identified. The Roman immersion has crossings and pinch points; physics uses the explicit triangle surface rather than a singular smooth metric. Crossing sheets remain independent.'
			},
			trefoil: {
				title: 'Trefoil knot',
				description: 'A closed tube woven into a three-lobed trefoil knot.',
				geometry:
					'A single unbroken tube follows the (2, 3) trefoil knot. Both chart angles wrap without reversing orientation. Overlapping strands in the view are separate regions of the tube; agents follow the connected triangle surface.'
			}
		};
		const copy = descriptions[world.shape];
		return {
			...copy,
			distance:
				'Local unfolded paths along the triangle surface; an approximate neighborhood distance.',
			physics:
				'Motion unfolds across connected triangle edges and transports tangent velocity. Orientation is tracked across reversing seams.',
			geometry: `${copy.geometry} Neighborhoods use local unfolded path estimates, with ranges below ${(world.radius * 0.15).toLocaleString(undefined, { maximumFractionDigits: 2 })} u (0.15 × surface scale).`
		};
	}
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
	throw new Error('Unsupported world geometry.');
}
