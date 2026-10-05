import type { TopologyShape, Vec3, WorldDefinition } from './types';
import { createTopologyMesh, type TopologyMesh } from './topology-mesh';

export type TopologyWorld = Extract<WorldDefinition, { shape: TopologyShape }>;
export const isTopologyWorld = (world: WorldDefinition): world is TopologyWorld =>
	world.kind === 'surface' && ['mobius', 'klein', 'projective', 'trefoil'].includes(world.shape);
const meshes = new Map<string, TopologyMesh>();
export function topologyMesh(world: TopologyWorld): TopologyMesh {
	const key = `${world.shape}:${world.radius}`;
	let mesh = meshes.get(key);
	if (!mesh) {
		mesh = createTopologyMesh(world.shape, world.radius);
		if (meshes.size >= 4) meshes.delete(meshes.keys().next().value!);
		meshes.set(key, mesh);
	}
	return mesh;
}
const add = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v + b[i]) as unknown as Vec3;
const sub = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v - b[i]) as unknown as Vec3;
const mul = (a: Vec3, t: number): Vec3 => a.map((v) => v * t) as unknown as Vec3;
const dot = (a: Vec3, b: Vec3) => a.reduce((s, v, i) => s + v * b[i], 0);

/** Closest point on one nondegenerate triangle, including its three edges. */
export function closestTriangle(point: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
	const ab = sub(b, a),
		ac = sub(c, a),
		ap = sub(point, a);
	const d1 = dot(ab, ap),
		d2 = dot(ac, ap);
	if (d1 <= 0 && d2 <= 0) return a;
	const bp = sub(point, b),
		d3 = dot(ab, bp),
		d4 = dot(ac, bp);
	if (d3 >= 0 && d4 <= d3) return b;
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
	const cp = sub(point, c),
		d5 = dot(ab, cp),
		d6 = dot(ac, cp);
	if (d6 >= 0 && d5 <= d6) return c;
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
		return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + d5 - d6)));
	const denominator = 1 / (va + vb + vc);
	return add(a, add(mul(ab, vb * denominator), mul(ac, vc * denominator)));
}
export function nearestTopologyPoint(mesh: TopologyMesh, point: Vec3, preferred?: number) {
	let distance = Infinity,
		triangle = 0,
		position = mesh.vertices[mesh.triangles[0][0]];
	const test = (face: number) => {
		const [a, b, c] = mesh.triangles[face].map((i) => mesh.vertices[i]);
		const candidate = closestTriangle(point, a, b, c);
		const d = dot(sub(candidate, point), sub(candidate, point));
		if (d < distance) {
			distance = d;
			triangle = face;
			position = candidate;
		}
	};
	if (preferred !== undefined && preferred >= 0 && preferred < mesh.triangles.length) {
		test(preferred);
		if (distance < 1e-12) return { triangle, position, distance: Math.sqrt(distance) };
	}
	for (let face = 0; face < mesh.triangles.length; face++) test(face);
	return { triangle, position, distance: Math.sqrt(distance) };
}
/** Picking retains the nearest sheet's triangle rather than reverse-mapping XYZ. */
export function pickTopologyRay(mesh: TopologyMesh, origin: Vec3, direction: Vec3) {
	const cross = (a: Vec3, b: Vec3): Vec3 => [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0]
	];
	let best = Infinity,
		triangle = -1;
	for (let face = 0; face < mesh.triangles.length; face++) {
		const [a, b, c] = mesh.triangles[face].map((i) => mesh.vertices[i]);
		const e1 = sub(b, a),
			e2 = sub(c, a),
			h = cross(direction, e2),
			det = dot(e1, h);
		if (Math.abs(det) < 1e-12) continue;
		const s = sub(origin, a),
			u = dot(s, h) / det;
		if (u < -1e-7 || u > 1 + 1e-7) continue;
		const q = cross(s, e1),
			v = dot(direction, q) / det;
		if (v < -1e-7 || u + v > 1 + 1e-7) continue;
		const t = dot(e2, q) / det;
		if (t > 1e-7 && t < best) {
			best = t;
			triangle = face;
		}
	}
	return triangle < 0
		? null
		: { position: add(origin, mul(direction, best)), normal: mesh.normals[triangle], triangle };
}
