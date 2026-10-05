import type { TopologyShape, Vec3 } from '#lib/model/types';
import { nativePoint } from '#lib/model/nonorientable-reference';

export type Triangle = readonly [number, number, number];
export interface TopologyMesh {
	shape: TopologyShape;
	vertices: Vec3[];
	triangles: Triangle[];
	/** Neighbor across the edge opposite each vertex; -1 denotes a physical edge. */
	neighbors: Triangle[];
	neighborEdges: Triangle[];
	/** Transition of the orientation double cover, not an identification of world positions. */
	edgeParity: Triangle[];
	normals: Vec3[];
	areas: number[];
	cumulativeAreas: number[];
	area: number;
	bounds: Vec3;
}
export interface TopologyState {
	triangle: number;
	barycentric: Vec3;
	orientation?: 1 | -1;
}
export interface TopologySample extends TopologyState {
	position: Vec3;
}
const TAU = 2 * Math.PI;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, t: number): Vec3 => [a[0] * t, a[1] * t, a[2] * t];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];
const norm = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3): Vec3 => mul(a, 1 / Math.max(1e-30, norm(a)));

/** Old Swarm's exact Dickson bottle, stood upright by its KleinY axis rotation.
 * Arguments are radians: u is longitudinal and v transverse. The quarter-turn
 * phase converts the raw V -> pi - V gluing into F(u+2pi,v)=F(u,-v).
 * Preserve the piecewise join at u=pi; this is a triangle metric, not a claim
 * that the old display formula is a globally smooth geodesic parametrization.
 * Source: ../swarm/src/lib/webgpu/embedding.ts kleinBase/surfKleinY.
 */
export function kleinBottlePoint(u: number, v: number): Vec3 {
	const turns = Math.floor(u / TAU),
		U = u - turns * TAU,
		V = (turns % 2 ? -v : v) + Math.PI / 2,
		cosU = Math.cos(U),
		sinU = Math.sin(U),
		cosV = Math.cos(V),
		sinV = Math.sin(V),
		c = 1 - 0.5 * cosU;
	const x = 6 * cosU * (1 + sinU) + 4 * c * (U <= Math.PI ? cosU * cosV : Math.cos(V + Math.PI));
	const y = 16 * sinU + (U <= Math.PI ? 4 * c * sinU * cosV : 0);
	// Old base is [x,z,y-8]; KleinY returns [base.y,-base.z,base.x].
	return [4 * c * sinV, 8 - y, x];
}

export const TREFOIL_DEFAULT_TUBE_RATIO = 0.15;
export const TREFOIL_MIN_TUBE_RATIO = 0.04;
export const TREFOIL_MAX_TUBE_RATIO = 0.16;

/** Smooth harmonic trefoil, upright in XY with its over/under crossings in Z.
 * Its exact periodic Frenet frame is regular: (C' x C'').z=31+4cos(3u)>0.
 * tubeRatio is the final physical tube radius / overall bounding radius.
 * The centerline has bounding radius 3; its outward normal at a radius maximum
 * gives tube extent 3+t, so t=3q/(1-q) preserves that ratio after scaling.
 */
export function trefoilSurfacePoint(
	u: number,
	v: number,
	tubeRatio = TREFOIL_DEFAULT_TUBE_RATIO
): Vec3 {
	if (
		!Number.isFinite(tubeRatio) ||
		tubeRatio < TREFOIL_MIN_TUBE_RATIO ||
		tubeRatio > TREFOIL_MAX_TUBE_RATIO
	)
		throw new Error('Unsupported trefoil tube ratio.');
	const c1 = Math.cos(u),
		s1 = Math.sin(u),
		c2 = Math.cos(2 * u),
		s2 = Math.sin(2 * u),
		c3 = Math.cos(3 * u),
		s3 = Math.sin(3 * u);
	// Rotate the harmonic curve by pi around Z: one lobe above the two lower
	// lobes, matching the upright sculptural pose. Derivatives share that rotation.
	const center: Vec3 = [-s1 - 2 * s2, -c1 + 2 * c2, -s3],
		first: Vec3 = [-c1 - 4 * c2, s1 - 4 * s2, -3 * c3],
		second: Vec3 = [s1 + 8 * s2, c1 - 8 * c2, 9 * s3],
		tangent = unit(first),
		binormal = unit(cross(first, second)),
		normal = cross(binormal, tangent),
		tubeRadius = (3 * tubeRatio) / (1 - tubeRatio);
	return add(center, mul(add(mul(normal, Math.cos(v)), mul(binormal, Math.sin(v))), tubeRadius));
}

function parametric(shape: 'mobius' | 'klein' | 'trefoil', resolution: number, tubeRatio: number) {
	const nu = resolution * (shape === 'trefoil' ? 4 : 2),
		nv =
			shape === 'mobius'
				? Math.max(4, Math.floor(resolution / 3))
				: shape === 'trefoil'
					? Math.max(8, 2 * Math.round(resolution / 3))
					: resolution;
	const vertices: Vec3[] = [],
		triangles: Triangle[] = [];
	for (let i = 0; i < nu; i++)
		for (let j = 0; j < (shape === 'mobius' ? nv + 1 : nv); j++)
			vertices.push(
				shape === 'mobius'
					? nativePoint(
							{ shape, radius: 1, halfWidth: 0.28 },
							{ u: (TAU * i) / nu, v: 0.28 * ((2 * j) / nv - 1) }
						)
					: shape === 'klein'
						? kleinBottlePoint((TAU * i) / nu, (TAU * j) / nv)
						: trefoilSurfacePoint((TAU * i) / nu, (TAU * j) / nv, tubeRatio)
			);
	const index = (i: number, j: number) => {
		if (i === nu) {
			i = 0;
			j = shape === 'mobius' ? nv - j : shape === 'klein' ? (nv - j) % nv : j;
		}
		return i * (shape === 'mobius' ? nv + 1 : nv) + (shape === 'mobius' ? j : j % nv);
	};
	for (let i = 0; i < nu; i++)
		for (let j = 0; j < nv; j++) {
			const a = index(i, j),
				b = index(i + 1, j),
				c = index(i, j + 1),
				d = index(i + 1, j + 1);
			triangles.push([a, b, c], [b, d, c]);
		}
	return { vertices, triangles };
}

/** Antipodal icosphere quotient, mapped by Steiner f(n)=(ny*nz,nz*nx,nx*ny).
 * This inherits old Swarm's Roman presentation. The smooth Roman map has six
 * pinch points; physics uses the explicit nondegenerate triangle metric here.
 * No embedded coordinate welding: coincident sheets keep distinct vertex IDs.
 * https://www.math.uci.edu/~vmm/docs/Cross-Cap.pdf
 */
function projective(resolution: number) {
	const t = (1 + Math.sqrt(5)) / 2;
	const initial: Vec3[] = [
		[-1, t, 0],
		[1, t, 0],
		[-1, -t, 0],
		[1, -t, 0],
		[0, -1, t],
		[0, 1, t],
		[0, -1, -t],
		[0, 1, -t],
		[t, 0, -1],
		[t, 0, 1],
		[-t, 0, -1],
		[-t, 0, 1]
	];
	let vertices = initial.map(unit);
	let triangles: Triangle[] = [
		[0, 11, 5],
		[0, 5, 1],
		[0, 1, 7],
		[0, 7, 10],
		[0, 10, 11],
		[1, 5, 9],
		[5, 11, 4],
		[11, 10, 2],
		[10, 7, 6],
		[7, 1, 8],
		[3, 9, 4],
		[3, 4, 2],
		[3, 2, 6],
		[3, 6, 8],
		[3, 8, 9],
		[4, 9, 5],
		[2, 4, 11],
		[6, 2, 10],
		[8, 6, 7],
		[9, 8, 1]
	];
	const levels = Math.max(2, Math.min(4, Math.round(Math.log2(resolution / 4))));
	for (let level = 0; level < levels; level++) {
		const mids = new Map<string, number>();
		const midpoint = (a: number, b: number) => {
			const key = `${Math.min(a, b)},${Math.max(a, b)}`;
			let index = mids.get(key);
			if (index === undefined) {
				index = vertices.length;
				vertices.push(unit(add(vertices[a], vertices[b])));
				mids.set(key, index);
			}
			return index;
		};
		const faces: Triangle[] = [];
		for (const [a, b, c] of triangles) {
			const ab = midpoint(a, b),
				bc = midpoint(b, c),
				ca = midpoint(c, a);
			faces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
		}
		triangles = faces;
	}
	// Canonical antipodal representative in parameter space, never in the image.
	const canonical = (n: Vec3) => {
		const first = n.find((value) => Math.abs(value) > 1e-10) ?? 1;
		return first < 0 ? mul(n, -1) : n;
	};
	const ids = new Map<string, number>(),
		remap: number[] = [],
		quotient: Vec3[] = [];
	for (const n of vertices) {
		const p = canonical(n),
			key = p.map((value) => value.toFixed(9)).join(',');
		let id = ids.get(key);
		if (id === undefined) {
			id = quotient.length;
			ids.set(key, id);
			quotient.push([2 * p[1] * p[2], 2 * p[2] * p[0], 2 * p[0] * p[1]]);
		}
		remap.push(id);
	}
	const seen = new Set<string>(),
		faces: Triangle[] = [];
	for (const tri of triangles) {
		const mapped = tri.map((i) => remap[i]) as unknown as Triangle;
		const key = [...mapped].sort((a, b) => a - b).join(',');
		if (!seen.has(key)) {
			seen.add(key);
			faces.push(mapped);
		}
	}
	vertices = quotient;
	return { vertices, triangles: faces };
}

export function createTopologyMesh(
	shape: TopologyShape,
	radius: number,
	resolution = 24,
	tubeRatio = TREFOIL_DEFAULT_TUBE_RATIO
): TopologyMesh {
	if (
		!Number.isFinite(radius) ||
		radius <= 0 ||
		!Number.isInteger(resolution) ||
		resolution < 8 ||
		resolution > 64
	)
		throw new Error('Invalid topology mesh dimensions.');
	const raw =
		shape === 'mobius' || shape === 'klein' || shape === 'trefoil'
			? parametric(shape, resolution, tubeRatio)
			: shape === 'projective'
				? projective(resolution)
				: (() => {
						throw new Error('Unsupported topology shape.');
					})();
	// The legacy bottle's y-8 offset does not center its bounding box. Translate
	// the exact upright shape for camera framing without altering its immersion.
	const center =
		shape === 'klein'
			? ([0, 1, 2].map((axis) => {
					const values = raw.vertices.map((p) => p[axis]);
					return (Math.min(...values) + Math.max(...values)) / 2;
				}) as unknown as Vec3)
			: ([0, 0, 0] as Vec3);
	const centered = raw.vertices.map((p) => sub(p, center)),
		extent = Math.max(...centered.map(norm));
	const vertices = centered.map((p) => mul(p, radius / extent));
	const triangles = raw.triangles;
	const neighbors = triangles.map(() => [-1, -1, -1] as [number, number, number]);
	const neighborEdges = triangles.map(() => [-1, -1, -1] as [number, number, number]);
	const edgeParity = triangles.map(() => [1, 1, 1] as [number, number, number]);
	const edges = new Map<string, { triangle: number; edge: number; a: number; b: number }>();
	const normals: Vec3[] = [],
		areas: number[] = [],
		cumulativeAreas: number[] = [];
	let area = 0;
	triangles.forEach((triangle, index) => {
		const [a, b, c] = triangle.map((i) => vertices[i]),
			normal = cross(sub(b, a), sub(c, a)),
			measure = norm(normal) / 2;
		if (measure <= 1e-12 * radius * radius)
			throw new Error(`Degenerate ${shape} triangle ${index}.`);
		normals.push(unit(normal));
		areas.push(measure);
		area += measure;
		cumulativeAreas.push(area);
		for (let e = 0; e < 3; e++) {
			const a = triangle[(e + 1) % 3],
				b = triangle[(e + 2) % 3],
				key = `${Math.min(a, b)},${Math.max(a, b)}`,
				other = edges.get(key);
			if (!other) edges.set(key, { triangle: index, edge: e, a, b });
			else {
				if (neighbors[other.triangle][other.edge] !== -1)
					throw new Error('Nonmanifold topological edge.');
				neighbors[index][e] = other.triangle;
				neighbors[other.triangle][other.edge] = index;
				neighborEdges[index][e] = other.edge;
				neighborEdges[other.triangle][other.edge] = e;
				const parity = other.a === a ? -1 : 1;
				edgeParity[index][e] = parity;
				edgeParity[other.triangle][other.edge] = parity;
			}
		}
	});
	const bounds = [0, 1, 2].map((axis) =>
		Math.max(...vertices.map((p) => Math.abs(p[axis])))
	) as unknown as Vec3;
	return {
		shape,
		vertices,
		triangles,
		neighbors,
		neighborEdges,
		edgeParity,
		normals,
		areas,
		cumulativeAreas,
		area,
		bounds
	};
}

export function topologyPoint(mesh: TopologyMesh, triangle: number, barycentric: Vec3): Vec3 {
	return mesh.triangles[triangle].reduce<Vec3>(
		(point, index, corner) => add(point, mul(mesh.vertices[index], barycentric[corner])),
		[0, 0, 0]
	);
}
export function topologyBarycentric(mesh: TopologyMesh, triangle: number, point: Vec3): Vec3 {
	const [a, b, c] = mesh.triangles[triangle].map((i) => mesh.vertices[i]),
		u = sub(b, a),
		v = sub(c, a),
		w = sub(point, a);
	const uu = dot(u, u),
		uv = dot(u, v),
		vv = dot(v, v),
		wu = dot(w, u),
		wv = dot(w, v),
		det = uu * vv - uv * uv;
	const y = (vv * wu - uv * wv) / det,
		z = (uu * wv - uv * wu) / det;
	return [1 - y - z, y, z];
}
export function sampleTopology(mesh: TopologyMesh, random: () => number): TopologySample {
	const target = random() * mesh.area;
	let lo = 0,
		hi = mesh.triangles.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (target < mesh.cumulativeAreas[mid]) hi = mid;
		else lo = mid + 1;
	}
	const a = Math.sqrt(random()),
		b = random(),
		barycentric: Vec3 = [1 - a, a * (1 - b), a * b];
	return {
		triangle: lo,
		barycentric,
		position: topologyPoint(mesh, lo, barycentric),
		orientation: 1
	};
}
/** Parallel transport for the explicit piecewise-flat metric; exact at triangle edges. */
export function topologyEdgeTransport(
	mesh: TopologyMesh,
	triangle: number,
	edge: number,
	vector: Vec3,
	orientation: 1 | -1 = 1
): Vec3 {
	const next = mesh.neighbors[triangle][edge];
	if (next < 0) return vector;
	const face = mesh.triangles[triangle],
		axis = unit(sub(mesh.vertices[face[(edge + 2) % 3]], mesh.vertices[face[(edge + 1) % 3]]));
	const from = mul(mesh.normals[triangle], orientation),
		to = mul(mesh.normals[next], orientation * mesh.edgeParity[triangle][edge]);
	return add(mul(axis, dot(vector, axis)), mul(cross(to, axis), dot(vector, cross(from, axis))));
}
/** Straightest barycentric walking with edge unfolding and specular physical-edge reflection. */
export function walkTopology(
	mesh: TopologyMesh,
	initial: TopologyState,
	displacement: Vec3,
	velocity: Vec3 = displacement,
	maxCrossings = 64,
	previousVelocity?: Vec3
): TopologySample & {
	velocity: Vec3;
	transportedPriorVelocity?: Vec3;
	crossings: number;
	complete: boolean;
} {
	let triangle = initial.triangle,
		barycentric = initial.barycentric,
		orientation = initial.orientation ?? 1;
	let remaining = sub(
		displacement,
		mul(mesh.normals[triangle], dot(displacement, mesh.normals[triangle]))
	);
	let moving = sub(velocity, mul(mesh.normals[triangle], dot(velocity, mesh.normals[triangle])));
	let prior = previousVelocity
		? sub(
				previousVelocity,
				mul(mesh.normals[triangle], dot(previousVelocity, mesh.normals[triangle]))
			)
		: undefined;
	let crossings = 0;
	for (; crossings < maxCrossings; crossings++) {
		const position = topologyPoint(mesh, triangle, barycentric),
			end = topologyBarycentric(mesh, triangle, add(position, remaining));
		let amount = 1,
			edge = -1;
		for (let e = 0; e < 3; e++)
			if (end[e] < -1e-10) {
				const t = barycentric[e] / (barycentric[e] - end[e]);
				if (t < amount) {
					amount = Math.max(0, t);
					edge = e;
				}
			}
		if (edge < 0) {
			barycentric = end;
			remaining = [0, 0, 0];
			break;
		}
		const hit = add(position, mul(remaining, amount));
		remaining = mul(remaining, 1 - amount);
		const next = mesh.neighbors[triangle][edge];
		if (next < 0) {
			const f = mesh.triangles[triangle],
				axis = unit(sub(mesh.vertices[f[(edge + 2) % 3]], mesh.vertices[f[(edge + 1) % 3]]));
			remaining = sub(mul(axis, 2 * dot(remaining, axis)), remaining);
			moving = sub(mul(axis, 2 * dot(moving, axis)), moving);
			barycentric = topologyBarycentric(mesh, triangle, hit);
		} else {
			remaining = topologyEdgeTransport(mesh, triangle, edge, remaining, orientation);
			moving = topologyEdgeTransport(mesh, triangle, edge, moving, orientation);
			if (prior) prior = topologyEdgeTransport(mesh, triangle, edge, prior, orientation);
			orientation = (orientation * mesh.edgeParity[triangle][edge]) as 1 | -1;
			triangle = next;
			barycentric = topologyBarycentric(mesh, triangle, hit);
		}
		// Exact edge hits need a tiny interior choice to prevent roundoff recrossings.
		barycentric = barycentric.map((value) => Math.max(1e-12, value)) as unknown as Vec3;
		barycentric = mul(barycentric, 1 / (barycentric[0] + barycentric[1] + barycentric[2]));
	}
	return {
		triangle,
		barycentric,
		orientation,
		position: topologyPoint(mesh, triangle, barycentric),
		velocity: moving,
		...(prior ? { transportedPriorVelocity: prior } : {}),
		crossings,
		complete: norm(remaining) < 1e-10
	};
}
