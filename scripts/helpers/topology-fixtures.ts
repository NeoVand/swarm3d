import type { TopologyMesh } from '../../src/lib/model/topology-mesh';
import type { Vec3 } from '../../src/lib/model/types';

export interface SurfaceIntersectionFixture {
	point: Vec3;
	fromTriangle: number;
	toTriangle: number;
	fromBarycentric: Vec3;
	toBarycentric: Vec3;
}
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];
type Face = readonly [Vec3, Vec3, Vec3];

function barycentric(point: Vec3, face: Face): Vec3 {
	const first = sub(face[1], face[0]),
		second = sub(face[2], face[0]),
		offset = sub(point, face[0]);
	const a = dot(first, first),
		b = dot(first, second),
		c = dot(second, second),
		d = dot(offset, first),
		e = dot(offset, second),
		denominator = a * c - b * b;
	const y = (c * d - b * e) / denominator,
		z = (a * e - b * d) / denominator;
	return [1 - y - z, y, z];
}

function pointOnFace(point: Vec3, face: Face, tolerance: number) {
	const normal = cross(sub(face[1], face[0]), sub(face[2], face[0]));
	if (Math.abs(dot(sub(point, face[0]), normal)) > tolerance * Math.hypot(...normal)) return false;
	return Math.min(...barycentric(point, face)) >= -1e-9;
}

/** Segment/triangle intersection, with both windings retained. */
function segmentHit(from: Vec3, to: Vec3, face: Face): Vec3 | undefined {
	const direction = sub(to, from),
		first = sub(face[1], face[0]),
		second = sub(face[2], face[0]),
		p = cross(direction, second),
		determinant = dot(first, p);
	if (
		Math.abs(determinant) <
		1e-12 * Math.hypot(...direction) * Math.hypot(...first) * Math.hypot(...second)
	)
		return;
	const inverse = 1 / determinant,
		offset = sub(from, face[0]),
		u = dot(offset, p) * inverse;
	if (u < -1e-9 || u > 1 + 1e-9) return;
	const q = cross(offset, first),
		v = dot(direction, q) * inverse;
	if (v < -1e-9 || u + v > 1 + 1e-9) return;
	const t = dot(second, q) * inverse;
	if (t < -1e-9 || t > 1 + 1e-9) return;
	return add(from, scale(direction, Math.max(0, Math.min(1, t))));
}

function faceHit(first: Face, second: Face, tolerance: number): Vec3 | undefined {
	// Covers shared geometric endpoints and coplanar overlap without requiring
	// sampled vertices on an analytic self-intersection curve.
	for (const point of first) if (pointOnFace(point, second, tolerance)) return point;
	for (const point of second) if (pointOnFace(point, first, tolerance)) return point;
	for (let edge = 0; edge < 3; edge++) {
		const hit = segmentHit(first[edge], first[(edge + 1) % 3], second);
		if (hit) return hit;
	}
	for (let edge = 0; edge < 3; edge++) {
		const hit = segmentHit(second[edge], second[(edge + 1) % 3], first);
		if (hit) return hit;
	}
}

/** Test-only fixtures from the actual piecewise planar geometry. A sweep of
 * triangle AABBs finds exact crossings, while graph hops distinguish separate
 * immersion sheets independently of the production neighborhood classifier. */
export function findSurfaceIntersections(
	mesh: TopologyMesh,
	maxPairs = 8,
	minimumFaceHops = 8
): SurfaceIntersectionFixture[] {
	const tolerance = Math.max(...mesh.bounds) * 1e-10;
	const faces = mesh.triangles.map(
		(face) => face.map((vertex) => mesh.vertices[vertex]) as unknown as Face
	);
	const bounds = faces.map((points, index) => ({
		index,
		low: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))),
		high: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis])))
	}));
	bounds.sort((a, b) => a.low[0] - b.low[0] || a.index - b.index);
	const nearby = new Map<number, Set<number>>();
	function localFaces(origin: number) {
		const cached = nearby.get(origin);
		if (cached) return cached;
		const visited = new Set([origin]);
		let wave = [origin];
		for (let hop = 0; hop < minimumFaceHops && wave.length; hop++) {
			const next: number[] = [];
			for (const face of wave) {
				for (const neighbor of mesh.neighbors[face]) {
					if (neighbor < 0 || visited.has(neighbor)) continue;
					visited.add(neighbor);
					next.push(neighbor);
				}
			}
			wave = next;
		}
		nearby.set(origin, visited);
		return visited;
	}
	const result: SurfaceIntersectionFixture[] = [],
		locations = new Set<string>();
	for (let i = 0; i < bounds.length; i++) {
		const a = bounds[i];
		for (let j = i + 1; j < bounds.length; j++) {
			const b = bounds[j];
			if (b.low[0] > a.high[0] + tolerance) break;
			if (
				b.low[1] > a.high[1] + tolerance ||
				a.low[1] > b.high[1] + tolerance ||
				b.low[2] > a.high[2] + tolerance ||
				a.low[2] > b.high[2] + tolerance ||
				mesh.triangles[a.index].some((vertex) => mesh.triangles[b.index].includes(vertex))
			)
				continue;
			const point = faceHit(faces[a.index], faces[b.index], tolerance);
			if (!point || localFaces(a.index).has(b.index)) continue;
			const key = point.map((value) => Math.round(value / tolerance)).join(',');
			if (locations.has(key)) continue;
			locations.add(key);
			result.push({
				point,
				fromTriangle: a.index,
				toTriangle: b.index,
				fromBarycentric: barycentric(point, faces[a.index]),
				toBarycentric: barycentric(point, faces[b.index])
			});
			if (result.length >= maxPairs) return result;
		}
	}
	return result;
}
