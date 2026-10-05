import type { Vec2, Vec3 } from '#lib/model/types';

/**
 * Independent next-stage correctness prototype. Not exported by #lib/model;
 * these are not supported WorldDefinition shapes or live physics algorithms.
 * Derivatives, metric seam laws and a complete native-chart candidate search
 * are executable. Motion/log/transport accuracy remains a separate gate.
 *
 * Display maps: Harvard/Oliver Knill's Möbius surface exhibit and Geomstats'
 * figure-eight Klein map (axis exchanged for Y). The induced metrics here are
 * differentiated from those maps. Geomstats' default Klein metric is flat;
 * it is deliberately not used for the visible immersion's physical geometry.
 * https://legacy-www.math.harvard.edu/~knill/teaching/math22a2018/exhibits/moebius/index.html
 * https://geomstats.github.io/_modules/geomstats/geometry/klein_bottle.html
 */
export type NativePoint = { u: number; v: number };
export type NativePrototype =
	| { shape: 'mobius'; radius: number; halfWidth: number }
	| { shape: 'klein'; majorRadius: number; sectionScale: number };
export type NativeMetric = { E: number; F: number; G: number };
export type NativeLift = NativePoint & { windingU: number; windingV: number; orientation: 1 | -1 };
export type NativePrototypeAgent = { id: number; point: NativePoint };
const TAU = 2 * Math.PI;
const dot = (a: Vec3, b: Vec3) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const negateParity = (winding: number): 1 | -1 => (winding % 2 === 0 ? 1 : -1);

export function assertNativePrototype(domain: NativePrototype): void {
	if (domain.shape === 'mobius') {
		if (
			!Number.isFinite(domain.radius) ||
			!Number.isFinite(domain.halfWidth) ||
			domain.halfWidth < 1 ||
			domain.radius < 3 * domain.halfWidth ||
			domain.radius > 10 * domain.halfWidth
		)
			throw new Error('Möbius prototype requires width≥1 and 3≤R/width≤10.');
	} else if (
		!Number.isFinite(domain.majorRadius) ||
		!Number.isFinite(domain.sectionScale) ||
		domain.sectionScale < 1 ||
		domain.majorRadius < 3 * domain.sectionScale ||
		domain.majorRadius > 10 * domain.sectionScale
	)
		throw new Error('Klein prototype requires scale≥1 and 3≤R/scale≤10.');
}
/** Exact quotient seam; width reflection is a separate physical boundary operation. */
export function canonicalNative(
	domain: NativePrototype,
	point: NativePoint,
	coordinateVelocity: Vec2 = [0, 0],
	orientation: 1 | -1 = 1
): { point: NativePoint; coordinateVelocity: Vec2; orientation: 1 | -1; crossings: number } {
	const crossings = Math.floor(point.u / TAU),
		sign = negateParity(crossings);
	let v = sign * point.v;
	if (domain.shape === 'klein') v -= TAU * Math.floor((v + Math.PI) / TAU);
	return {
		point: { u: point.u - crossings * TAU, v },
		coordinateVelocity: [coordinateVelocity[0], sign * coordinateVelocity[1]],
		orientation: (sign * orientation) as 1 | -1,
		crossings
	};
}
export function nativePoint(domain: NativePrototype, point: NativePoint): Vec3 {
	const { u, v } = point;
	if (domain.shape === 'mobius') {
		const radial = domain.radius + v * Math.cos(u / 2);
		return [radial * Math.cos(u), v * Math.sin(u / 2), radial * Math.sin(u)];
	}
	const scale = domain.sectionScale,
		A = Math.cos(u / 2) * Math.sin(v) - Math.sin(u / 2) * Math.sin(2 * v),
		B = Math.sin(u / 2) * Math.sin(v) + Math.cos(u / 2) * Math.sin(2 * v),
		radial = domain.majorRadius + scale * A;
	return [radial * Math.cos(u), scale * B, radial * Math.sin(u)];
}
export function nativeJacobian(domain: NativePrototype, point: NativePoint): readonly [Vec3, Vec3] {
	const { u, v } = point,
		c = Math.cos(u / 2),
		s = Math.sin(u / 2),
		cu = Math.cos(u),
		su = Math.sin(u);
	if (domain.shape === 'mobius') {
		const radial = domain.radius + v * c;
		return [
			[-radial * su - (v * s * cu) / 2, (v * c) / 2, radial * cu - (v * s * su) / 2],
			[c * cu, s, c * su]
		];
	}
	const scale = domain.sectionScale,
		A = c * Math.sin(v) - s * Math.sin(2 * v),
		B = s * Math.sin(v) + c * Math.sin(2 * v),
		Av = c * Math.cos(v) - 2 * s * Math.cos(2 * v),
		Bv = s * Math.cos(v) + 2 * c * Math.cos(2 * v),
		radial = domain.majorRadius + scale * A;
	return [
		[-radial * su - (scale * B * cu) / 2, (scale * A) / 2, radial * cu - (scale * B * su) / 2],
		[scale * Av * cu, scale * Bv, scale * Av * su]
	];
}
export function nativeMetric(domain: NativePrototype, point: NativePoint): NativeMetric {
	const { u, v } = point;
	if (domain.shape === 'mobius')
		return { E: (domain.radius + v * Math.cos(u / 2)) ** 2 + (v * v) / 4, F: 0, G: 1 };
	const scale = domain.sectionScale,
		A = Math.cos(u / 2) * Math.sin(v) - Math.sin(u / 2) * Math.sin(2 * v),
		crossSection = Math.sin(v) ** 2 + Math.sin(2 * v) ** 2;
	return {
		E: (domain.majorRadius + scale * A) ** 2 + (scale ** 2 * crossSection) / 4,
		F: -(scale ** 2) * Math.sin(v) ** 3,
		G: scale ** 2 * (Math.cos(v) ** 2 + 4 * Math.cos(2 * v) ** 2)
	};
}
export function nativeMetricFromJacobian(
	domain: NativePrototype,
	point: NativePoint
): NativeMetric {
	const [u, v] = nativeJacobian(domain, point);
	return { E: dot(u, u), F: dot(u, v), G: dot(v, v) };
}
export const nativeMetricNorm = (metric: NativeMetric, vector: Vec2): number =>
	Math.sqrt(
		Math.max(
			0,
			metric.E * vector[0] ** 2 + 2 * metric.F * vector[0] * vector[1] + metric.G * vector[1] ** 2
		)
	);
export const nativeAreaElement = (metric: NativeMetric): number =>
	Math.sqrt(metric.E * metric.G - metric.F ** 2);
export function nativeWorldVector(
	domain: NativePrototype,
	point: NativePoint,
	coordinateVelocity: Vec2
): Vec3 {
	const [u, v] = nativeJacobian(domain, point);
	return u.map(
		(value, axis) => value * coordinateVelocity[0] + v[axis] * coordinateVelocity[1]
	) as unknown as Vec3;
}
/** Images sufficient for the proposed small local search, not unrestricted global geodesics. */
export function nativeImages(domain: NativePrototype, point: NativePoint): NativeLift[] {
	const result: NativeLift[] = [];
	for (let m = -1; m <= 1; m++)
		for (let n = domain.shape === 'klein' ? -1 : 0; n <= (domain.shape === 'klein' ? 1 : 0); n++)
			result.push({
				u: point.u + m * TAU,
				v: negateParity(m) * point.v + n * TAU,
				windingU: m,
				windingV: n,
				orientation: negateParity(m)
			});
	return result;
}
export function nativeMidpointRelation(
	domain: NativePrototype,
	from: NativePoint,
	to: NativePoint
): { distance: number; displacement: Vec2; lift: NativeLift } {
	let best: { distance: number; displacement: Vec2; lift: NativeLift } | undefined;
	for (const lift of nativeImages(domain, to)) {
		const displacement: Vec2 = [lift.u - from.u, lift.v - from.v];
		const metric = nativeMetric(domain, { u: (from.u + lift.u) / 2, v: (from.v + lift.v) / 2 }),
			distance = nativeMetricNorm(metric, displacement);
		if (!best || distance < best.distance) best = { distance, displacement, lift };
	}
	return best!;
}
/** Tentative query envelope. Accuracy against shooting is NOT certified by this prototype. */
export function nativePrototypeRange(domain: NativePrototype): number {
	assertNativePrototype(domain);
	return 0.1 * (domain.shape === 'mobius' ? domain.halfWidth : domain.sectionScale);
}
/** Analytic positive-definiteness bound for the figure-eight immersion in this shape envelope. */
export function kleinMetricEigenvalueLowerBound(
	domain: Extract<NativePrototype, { shape: 'klein' }>
): number {
	const { majorRadius: R, sectionScale: s } = domain;
	return ((R - 1.25 * s) ** 2 * (31 / 64) * s * s) / ((R + 1.25 * s) ** 2 + (345 / 64) * s * s);
}
export function nativeCoordinateReach(domain: NativePrototype, radius: number): Vec2 {
	if (!Number.isFinite(radius) || radius <= 0 || radius > nativePrototypeRange(domain))
		throw new Error('Native query exceeds the tentative prototype envelope.');
	if (domain.shape === 'mobius') return [radius / (domain.radius - domain.halfWidth), radius];
	const reach = radius / Math.sqrt(kleinMetricEigenvalueLowerBound(domain));
	return [reach, reach];
}
export function nativeAllPairs(
	domain: NativePrototype,
	agents: readonly NativePrototypeAgent[],
	self: number,
	radius: number
): number[] {
	nativeCoordinateReach(domain, radius);
	return agents
		.filter(
			(other) =>
				other.id !== agents[self].id &&
				nativeMidpointRelation(domain, agents[self].point, other.point).distance <= radius
		)
		.map((agent) => agent.id)
		.sort((a, b) => a - b);
}
/** Complete native-chart grid: no world-position lookup, no cell/neighbor capacity, ID deduplication. */
export function nativeGrid(
	domain: NativePrototype,
	agents: readonly NativePrototypeAgent[],
	radius: number
): { query: (self: number) => number[]; cells: number } {
	const [widthU, widthV] = nativeCoordinateReach(domain, radius);
	const key = (u: number, v: number) => `${Math.floor(u / widthU)},${Math.floor(v / widthV)}`;
	const cells = new Map<string, number[]>();
	agents.forEach((agent, index) => {
		const id = key(agent.point.u, agent.point.v),
			list = cells.get(id) ?? [];
		list.push(index);
		cells.set(id, list);
	});
	return {
		cells: cells.size,
		query(self) {
			const candidates = new Set<number>();
			for (const lift of nativeImages(domain, agents[self].point)) {
				const centerU = Math.floor(lift.u / widthU),
					centerV = Math.floor(lift.v / widthV);
				for (let u = centerU - 1; u <= centerU + 1; u++)
					for (let v = centerV - 1; v <= centerV + 1; v++)
						for (const index of cells.get(`${u},${v}`) ?? []) candidates.add(index);
			}
			return [...candidates]
				.filter(
					(index) =>
						agents[index].id !== agents[self].id &&
						nativeMidpointRelation(domain, agents[self].point, agents[index].point).distance <=
							radius
				)
				.map((index) => agents[index].id)
				.sort((a, b) => a - b);
		}
	};
}
