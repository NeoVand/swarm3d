import {
	add,
	dot,
	magnitude,
	scale,
	subtract,
	worldNormal,
	type Vec3,
	type WorldDefinition
} from '#lib/model';

/** Keep this presentation-only calculation in parity with common.wgsl view_lift.
 * Inward bodies must clear the polygonal depth skin's worst facet sagitta.
 */
export function surfaceViewLift(
	world: WorldDefinition,
	point: Vec3,
	eye: Vec3,
	lift: number
): number {
	if (world.kind !== 'surface') return 0;
	const normal = worldNormal(world, point);
	if (dot(normal, subtract(eye, point)) >= 0) return lift;
	let clearance = 0;
	if (world.shape === 'sphere')
		clearance = magnitude(point) * (1 - Math.cos((Math.sqrt(2) * Math.PI) / 60));
	if (world.shape === 'cylinder')
		clearance = Math.hypot(point[0], point[2]) * (1 - Math.cos(Math.PI / 60));
	if (world.shape === 'torus') {
		const tube = Math.hypot(Math.hypot(point[0], point[2]) - world.majorRadius, point[1]);
		clearance =
			tube * (1 - Math.cos(Math.PI / 64)) +
			(world.majorRadius + tube) * (1 - Math.cos(Math.PI / 144));
	}
	return -lift - clearance;
}

/** The exact body center used by boids.wgsl, independent of physical state.
 * Limit cosmetic displacement near the eye so the marker cannot cross it.
 * Picking projects this center; inspection still returns physical coordinates.
 */
export function agentRenderCenter(
	world: WorldDefinition,
	point: Vec3,
	size: number,
	eye: Vec3
): Vec3 {
	if (world.kind !== 'surface') return point;
	const lifted = surfaceViewLift(world, point, eye, size * 1.1);
	const displacement =
		Math.sign(lifted) * Math.min(Math.abs(lifted), magnitude(subtract(eye, point)) * 0.35);
	return add(point, scale(worldNormal(world, point), displacement));
}
