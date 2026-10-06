import {
	add,
	dot,
	magnitude,
	scale,
	subtract,
	isTopologyWorld,
	worldNormal,
	isSmoothTopologyWorld,
	smoothTopologyChart,
	smoothTopologyDisplayNormal,
	topologyMesh,
	topologyBarycentric,
	nearestTopologyPoint,
	normalize,
	type Vec2,
	type TopologyMesh,
	type Vec3,
	type WorldDefinition
} from '#lib/model';
import { packTopologyDisplayNormals } from './topology-display-normals';

const displayFields = new WeakMap<TopologyMesh, Float32Array>();
/** Rendering and picking share presentation normals; physical rules still use
 * the derivative field or exact polyhedral face normal in model/geometry. */
export function surfaceDisplayNormal(
	world: WorldDefinition,
	point: Vec3,
	triangle?: number,
	chart?: Vec2
): Vec3 {
	if (isSmoothTopologyWorld(world))
		return smoothTopologyDisplayNormal(world, chart ?? smoothTopologyChart(world, point, triangle));
	if (isTopologyWorld(world)) {
		const mesh = topologyMesh(world),
			face = triangle ?? nearestTopologyPoint(mesh, point).triangle;
		let data = displayFields.get(mesh);
		if (!data) {
			data = packTopologyDisplayNormals(mesh);
			displayFields.set(mesh, data);
		}
		const bary = topologyBarycentric(mesh, face, point);
		const normal = [0, 1, 2].map((axis) =>
			bary.reduce(
				(sum, weight, corner) => sum + weight * data[4 + face * 12 + corner * 4 + axis],
				0
			)
		) as unknown as Vec3;
		return normalize(normal);
	}
	return worldNormal(world, point, triangle);
}

/** Keep this presentation-only calculation in parity with common.wgsl view_lift.
 * Inward bodies must clear the polygonal depth skin's worst facet sagitta.
 */
export function surfaceViewLift(
	world: WorldDefinition,
	point: Vec3,
	eye: Vec3,
	lift: number,
	triangle?: number,
	chart?: Vec2
): number {
	if (world.kind !== 'surface') return 0;
	const normal = surfaceDisplayNormal(world, point, triangle, chart);
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
	eye: Vec3,
	triangle?: number,
	chart?: Vec2
): Vec3 {
	if (world.kind !== 'surface') return point;
	const lifted = surfaceViewLift(world, point, eye, size * 1.1, triangle, chart);
	const displacement =
		Math.sign(lifted) * Math.min(Math.abs(lifted), magnitude(subtract(eye, point)) * 0.35);
	return add(point, scale(surfaceDisplayNormal(world, point, triangle, chart), displacement));
}
