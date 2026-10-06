import type { Vec2, Vec3, WorldDefinition } from './types';
import {
	kleinBottlePoint,
	trefoilSurfacePoint,
	TREFOIL_DEFAULT_TUBE_RATIO,
	topologyBarycentric
} from './topology-mesh';
import { topologyMesh, trefoilTubeRatio, nearestTopologyPoint } from './topology-world';

export type SmoothTopologyShape = 'mobius' | 'klein' | 'trefoil';
export type SmoothTopologyWorld = Extract<WorldDefinition, { kind: 'surface'; radius: number }> & {
	shape: SmoothTopologyShape;
};
export const isSmoothTopologyWorld = (world: WorldDefinition): world is SmoothTopologyWorld =>
	world.kind === 'surface' && ['mobius', 'klein', 'trefoil'].includes(world.shape);
const TAU = 2 * Math.PI;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];
const norm = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3) => mul(a, 1 / Math.max(norm(a), 1e-20));
const mod = (v: number) => v - Math.floor(v);
const arrays = new Map<string, Float32Array<ArrayBuffer>>();
export const smoothTopologyDimensions = (shape: SmoothTopologyShape): Vec2 =>
	shape === 'trefoil' ? [96, 16] : shape === 'klein' ? [48, 24] : [48, 8];
function rawPoint(shape: SmoothTopologyShape, uv: Vec2, ratio: number): Vec3 {
	if (shape === 'klein') return kleinBottlePoint(uv[0] * TAU, uv[1] * TAU);
	if (shape === 'trefoil') return trefoilSurfacePoint(uv[0] * TAU, uv[1] * TAU, ratio);
	const u = uv[0] * TAU,
		v = 0.28 * (2 * uv[1] - 1),
		r = 1 + v * Math.cos(u / 2);
	return [r * Math.cos(u), v * Math.sin(u / 2), r * Math.sin(u)];
}
/** Immutable C1 Hermite approximation of the visible map. Derivatives are in
 * normalized chart turns. Unit geometry is cached as a small immutable CPU lookup; each runtime owns its GPU copy. */
export function packSmoothTopologyField(
	shape: SmoothTopologyShape,
	tubeRatio = TREFOIL_DEFAULT_TUBE_RATIO
): Float32Array<ArrayBuffer> {
	const key = `${shape}:${tubeRatio}`,
		cached = arrays.get(key);
	if (cached) return cached;
	const [nu, nv] = smoothTopologyDimensions(shape),
		points: Vec3[] = [];
	for (let j = 0; j <= nv; j++)
		for (let i = 0; i <= nu; i++) points.push(rawPoint(shape, [i / nu, j / nv], tubeRatio));
	// Exactly the same centering and normalization as the triangle display/picking mesh.
	const ordinary: Vec3[] = [];
	for (let i = 0; i < nu; i++)
		for (let j = 0; j < (shape === 'mobius' ? nv + 1 : nv); j++)
			ordinary.push(rawPoint(shape, [i / nu, j / nv], tubeRatio));
	const center: Vec3 =
		shape === 'klein'
			? ([0, 1, 2].map(
					(axis) =>
						(Math.min(...ordinary.map((p) => p[axis])) +
							Math.max(...ordinary.map((p) => p[axis]))) /
						2
				) as unknown as Vec3)
			: [0, 0, 0];
	const extent = Math.max(...ordinary.map((p) => norm(sub(p, center)))),
		jets = new Float64Array(points.length * 16),
		normals = new Float32Array(points.length * 4),
		h = 1e-5;

	for (let j = 0; j <= nv; j++)
		for (let i = 0; i <= nu; i++) {
			const u = i / nu,
				v = j / nv,
				at = (i + (nu + 1) * j) * 16;
			const p = rawPoint(shape, [u, v], tubeRatio),
				pu = rawPoint(shape, [u + h, v], tubeRatio),
				mu = rawPoint(shape, [u - h, v], tubeRatio),
				pv = rawPoint(shape, [u, v + h], tubeRatio),
				mv = rawPoint(shape, [u, v - h], tubeRatio);
			const pp = rawPoint(shape, [u + h, v + h], tubeRatio),
				pm = rawPoint(shape, [u + h, v - h], tubeRatio),
				mp = rawPoint(shape, [u - h, v + h], tubeRatio),
				mm = rawPoint(shape, [u - h, v - h], tubeRatio);
			jets.set(mul(sub(p, center), 1 / extent), at);
			jets.set(mul(sub(pu, mu), 1 / (2 * h * extent)), at + 4);
			jets.set(mul(sub(pv, mv), 1 / (2 * h * extent)), at + 8);
			jets.set(mul(add(sub(pp, pm), sub(mm, mp)), 1 / (4 * h * h * extent)), at + 12);
			normals.set(unit(cross(sub(pu, mu), sub(pv, mv))), (i + (nu + 1) * j) * 4);
		}
	const normalBase = 1 + 16 * nu * nv,
		data = new Float32Array((normalBase + points.length) * 4);
	data.set([nu, nv, 16, normalBase]);
	data.set(normals, normalBase * 4);
	const H = [
		[1, 0, 0, 0],
		[0, 0, 1, 0],
		[-3, 3, -2, -1],
		[2, -2, 1, 1]
	];
	for (let j = 0; j < nv; j++)
		for (let i = 0; i < nu; i++) {
			const at = 4 + (i + nu * j) * 64;
			for (let a = 0; a < 4; a++)
				for (let b = 0; b < 4; b++)
					for (let axis = 0; axis < 3; axis++) {
						let coefficient = 0;
						for (let k = 0; k < 4; k++)
							for (let l = 0; l < 4; l++) {
								const ut = k >= 2,
									vt = l >= 2,
									x = k % 2,
									y = l % 2,
									jet = (ut ? 1 : 0) + (vt ? 2 : 0),
									index = (i + x + (nu + 1) * (j + y)) * 16 + jet * 4 + axis;
								coefficient +=
									H[a][k] * H[b][l] * jets[index] * (ut ? 1 / nu : 1) * (vt ? 1 / nv : 1);
							}
						data[at + (a + 4 * b) * 4 + axis] = coefficient;
					}
		}

	if (arrays.size >= 4) arrays.delete(arrays.keys().next().value!);
	arrays.set(key, data);
	return data;
}
export interface SmoothSurface {
	position: Vec3;
	u: Vec3;
	v: Vec3;
	normal: Vec3;
}
export function canonicalSmoothChart(
	shape: SmoothTopologyShape,
	uv: Vec2,
	orientation: 1 | -1 = 1
) {
	const turns = Math.floor(uv[0]),
		parity = shape !== 'trefoil' && Math.abs(turns) % 2 === 1 ? -1 : 1;
	let v = uv[1];
	if (parity < 0) v = shape === 'mobius' ? 1 - v : -v;
	return {
		uv: [mod(uv[0]), shape === 'mobius' ? Math.max(0, Math.min(1, v)) : mod(v)] as Vec2,
		orientation: (orientation * parity) as 1 | -1,
		parity: parity as 1 | -1
	};
}
export function evaluateSmoothTopologyField(
	data: Float32Array,
	shape: SmoothTopologyShape,
	uv: Vec2,
	radius = 1
): SmoothSurface {
	const canonical = canonicalSmoothChart(shape, uv),
		[nu, nv] = data;
	const x = Math.min(canonical.uv[0] * nu, nu - 1e-10),
		y = Math.min(canonical.uv[1] * nv, nv - 1e-10),
		ix = Math.floor(x),
		iy = Math.floor(y),
		t = x - ix,
		q = y - iy,
		at = 4 + (ix + nu * iy) * 64;
	const p = [0, 0, 0],
		up = [0, 0, 0],
		vp = [0, 0, 0];
	for (let axis = 0; axis < 3; axis++) {
		const values = [0, 0, 0, 0],
			derivatives = [0, 0, 0, 0];
		for (let row = 0; row < 4; row++) {
			const offset = at + row * 16 + axis,
				a = data[offset],
				b = data[offset + 4],
				c = data[offset + 8],
				d = data[offset + 12];
			values[row] = ((d * t + c) * t + b) * t + a;
			derivatives[row] = (3 * d * t + 2 * c) * t + b;
		}
		p[axis] = ((values[3] * q + values[2]) * q + values[1]) * q + values[0];
		up[axis] =
			(((derivatives[3] * q + derivatives[2]) * q + derivatives[1]) * q + derivatives[0]) * nu;
		vp[axis] = ((3 * values[3] * q + 2 * values[2]) * q + values[1]) * nv;
	}
	let position = p as unknown as Vec3,
		u = up as unknown as Vec3,
		v = vp as unknown as Vec3;
	u = mul(u, radius);
	v = mul(v, radius * canonical.parity);
	position = mul(position, radius);
	return { position, u, v, normal: unit(cross(u, v)) };
}
export function smoothTopologySurface(world: SmoothTopologyWorld, uv: Vec2): SmoothSurface {
	return evaluateSmoothTopologyField(
		packSmoothTopologyField(
			world.shape,
			world.shape === 'trefoil' ? trefoilTubeRatio(world) : undefined
		),
		world.shape,
		uv,
		world.radius
	);
}
export function smoothTopologyTriangle(world: SmoothTopologyWorld, uv: Vec2): number {
	const [nu, nv] = smoothTopologyDimensions(world.shape),
		p = canonicalSmoothChart(world.shape, uv).uv,
		x = Math.min(p[0] * nu, nu - 1e-8),
		y = Math.min(p[1] * nv, nv - 1e-8),
		i = Math.floor(x),
		j = Math.floor(y);
	return 2 * (i * nv + j) + (x - i + y - j > 1 ? 1 : 0);
}
export function smoothTopologyChart(
	world: SmoothTopologyWorld,
	position: Vec3,
	triangle?: number
): Vec2 {
	const mesh = topologyMesh(world),
		face = triangle ?? nearestTopologyPoint(mesh, position).triangle;
	const bary = topologyBarycentric(mesh, face, position),
		chart = mesh.charts[face];
	let uv: Vec2 = [0, 1].map((axis) =>
		chart.reduce((sum, p, i) => sum + p[axis] * bary[i], 0)
	) as unknown as Vec2;
	// Tagged local inverse never searches an unrelated self-intersection sheet.
	for (let step = 0; step < 5; step++) {
		const s = smoothTopologySurface(world, uv),
			d = sub(position, s.position),
			delta = smoothCoordinates(s, d);
		uv = [uv[0] + delta[0], uv[1] + delta[1]];
		if (norm(d) < world.radius * 1e-9) break;
	}
	return canonicalSmoothChart(world.shape, uv).uv;
}
/** Presentation-only normal lookup shared with the four-node GPU shading path. */
export function smoothTopologyDisplayNormal(world: SmoothTopologyWorld, uv: Vec2): Vec3 {
	const data = packSmoothTopologyField(
			world.shape,
			world.shape === 'trefoil' ? trefoilTubeRatio(world) : undefined
		),
		canonical = canonicalSmoothChart(world.shape, uv),
		nu = data[0];
	const grid = canonical.uv.map((value, axis) =>
			Math.min(value * data[axis], data[axis] - 0.00001)
		),
		ix = Math.floor(grid[0]),
		iy = Math.floor(grid[1]),
		x = grid[0] - ix,
		y = grid[1] - iy,
		row = data[3] + ix + (nu + 1) * iy;
	const normal: Vec3 = [0, 1, 2].map((axis) => {
		const lower = data[row * 4 + axis] * (1 - x) + data[(row + 1) * 4 + axis] * x;
		const upper = data[(row + nu + 1) * 4 + axis] * (1 - x) + data[(row + nu + 2) * 4 + axis] * x;
		return (lower * (1 - y) + upper * y) * canonical.parity;
	}) as unknown as Vec3;
	return unit(normal);
}
export function smoothCoordinates(s: SmoothSurface, vector: Vec3): Vec2 {
	const E = dot(s.u, s.u),
		F = dot(s.u, s.v),
		G = dot(s.v, s.v),
		a = dot(vector, s.u),
		b = dot(vector, s.v),
		det = Math.max(E * G - F * F, 1e-20);
	return [(G * a - F * b) / det, (E * b - F * a) / det];
}
export function smoothTopologyLift(world: SmoothTopologyWorld, from: Vec2, to: Vec2): Vec2 {
	const turn = Math.round(from[0] - to[0]),
		parity = world.shape !== 'trefoil' && Math.abs(turn) % 2 === 1 ? -1 : 1;
	let v = parity < 0 ? (world.shape === 'mobius' ? 1 - to[1] : -to[1]) : to[1];
	if (world.shape !== 'mobius') v += Math.round(from[1] - v);
	return [to[0] + turn, v];
}
function normalTransport(vector: Vec3, from: Vec3, to: Vec3): Vec3 {
	const denominator = 1 + dot(from, to);
	if (denominator < 1e-7) return sub(vector, mul(to, dot(vector, to)));
	return sub(vector, mul(add(from, to), dot(vector, to) / denominator));
}
/** Three-point induced-metric quadrature along a topology-valid chart lift.
 * Local approximation, not an exact geodesic logarithm. Continuous across chart cells. */
export function smoothTopologyRelation(
	world: SmoothTopologyWorld,
	from: Vec2,
	to: Vec2,
	velocity: Vec3 = [0, 0, 0]
) {
	const lift = smoothTopologyLift(world, from, to),
		delta: Vec2 = [lift[0] - from[0], lift[1] - from[1]],
		a = smoothTopologySurface(world, from),
		mid = smoothTopologySurface(world, [(from[0] + lift[0]) / 2, (from[1] + lift[1]) / 2]),
		b = smoothTopologySurface(world, lift);
	const direction = (s: SmoothSurface) => add(mul(s.u, delta[0]), mul(s.v, delta[1]));
	const distance = Math.max(
		(norm(direction(a)) + 4 * norm(direction(mid)) + norm(direction(b))) / 6,
		norm(sub(b.position, a.position))
	);
	return {
		displacement: mul(unit(direction(a)), distance),
		distance,
		velocity: normalTransport(
			normalTransport(velocity, b.normal, mid.normal),
			mid.normal,
			a.normal
		),
		lift
	};
}
export function smoothTopologyAdvance(
	world: SmoothTopologyWorld,
	uv: Vec2,
	displacement: Vec3,
	velocity: Vec3 = displacement,
	previous?: Vec3,
	orientation: 1 | -1 = 1
) {
	const a = smoothTopologySurface(world, uv),
		first = smoothCoordinates(a, displacement),
		midUV: Vec2 = [uv[0] + first[0] / 2, uv[1] + first[1] / 2],
		mid = smoothTopologySurface(world, midUV),
		middleMovement = normalTransport(displacement, a.normal, mid.normal),
		step = smoothCoordinates(mid, middleMovement);
	let end: Vec2 = [uv[0] + step[0], uv[1] + step[1]],
		reflected = false;
	if (world.shape === 'mobius' && (end[1] < 0 || end[1] > 1)) {
		const t = ((end[1] % 2) + 2) % 2;
		end = [end[0], t <= 1 ? t : 2 - t];
		reflected = true;
	}
	const canonical = canonicalSmoothChart(world.shape, end, orientation),
		b = smoothTopologySurface(world, end);
	let moving = normalTransport(
		normalTransport(velocity, a.normal, mid.normal),
		mid.normal,
		b.normal
	);
	const old = previous
		? normalTransport(normalTransport(previous, a.normal, mid.normal), mid.normal, b.normal)
		: undefined;
	if (reflected) {
		const along = unit(b.u);
		moving = sub(mul(along, 2 * dot(moving, along)), moving);
	}
	return {
		position: b.position,
		velocity: moving,
		triangle: smoothTopologyTriangle(world, canonical.uv),
		chart: canonical.uv,
		orientation: canonical.orientation,
		...(old ? { transportedPriorVelocity: old } : {})
	};
}
