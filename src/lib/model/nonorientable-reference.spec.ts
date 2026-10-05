import { describe, expect, it } from 'vitest';
import type { Vec2, Vec3 } from '#lib/model/types';
import {
	canonicalNative,
	kleinMetricEigenvalueLowerBound,
	nativeAllPairs,
	nativeAreaElement,
	nativeCoordinateReach,
	nativeGrid,
	nativeJacobian,
	nativeMetric,
	nativeMetricFromJacobian,
	nativeMetricNorm,
	nativeMidpointRelation,
	nativePoint,
	nativePrototypeRange,
	nativeWorldVector
} from '#lib/model/nonorientable-reference';
import type {
	NativePoint,
	NativePrototype,
	NativePrototypeAgent
} from '#lib/model/nonorientable-reference';

const mobius = { shape: 'mobius', radius: 3, halfWidth: 1 } as const;
const klein = { shape: 'klein', majorRadius: 3, sectionScale: 1 } as const;
const norm = (a: Vec3) => Math.hypot(...a);
const difference = (a: Vec3, b: Vec3) => norm(a.map((v, i) => v - b[i]) as unknown as Vec3);
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];
const normal = (domain: NativePrototype, point: NativePoint): Vec3 => {
	const [u, v] = nativeJacobian(domain, point),
		n = cross(u, v),
		length = norm(n);
	return n.map((x) => x / length) as unknown as Vec3;
};

describe('nonorientable native geometry gate prototype', () => {
	it.each([mobius, klein])(
		'differentiates the regular $shape immersion and its induced metric',
		(domain) => {
			for (let i = 0; i < 20; i++)
				for (let j = 0; j < 20; j++) {
					const point = {
							u: (i * 2 * Math.PI) / 20,
							v: domain.shape === 'mobius' ? -1 + (2 * j) / 19 : -Math.PI + (2 * Math.PI * j) / 20
						},
						h = 1e-6;
					const [u, v] = nativeJacobian(domain, point),
						metric = nativeMetric(domain, point),
						direct = nativeMetricFromJacobian(domain, point);
					const finite = (axis: 'u' | 'v'): Vec3 => {
						const upper = nativePoint(domain, { ...point, [axis]: point[axis] + h }),
							lower = nativePoint(domain, { ...point, [axis]: point[axis] - h });
						return upper.map((value, k) => (value - lower[k]) / (2 * h)) as unknown as Vec3;
					};
					expect(difference(u, finite('u'))).toBeLessThan(3e-9);
					expect(difference(v, finite('v'))).toBeLessThan(3e-9);
					for (const component of ['E', 'F', 'G'] as const)
						expect(metric[component]).toBeCloseTo(direct[component], 12);
					expect(nativeAreaElement(metric)).toBeGreaterThan(0);
				}
		}
	);
	it.each([mobius, klein])(
		'preserves $shape metric, tangent vectors and embedding under the twisted seam',
		(domain) => {
			for (const v of [-0.9, -0.2, 0, 0.2, 0.9]) {
				const point = { u: 0.7, v },
					lift = { u: 0.7 + 2 * Math.PI, v: -v },
					velocity: Vec2 = [0.13, -0.27],
					metric = nativeMetric(domain, point),
					liftMetric = nativeMetric(domain, lift);
				expect(liftMetric.E).toBeCloseTo(metric.E, 12);
				expect(liftMetric.F).toBeCloseTo(-metric.F, 12);
				expect(liftMetric.G).toBeCloseTo(metric.G, 12);
				expect(difference(nativePoint(domain, point), nativePoint(domain, lift))).toBeLessThan(
					1e-12
				);
				expect(
					difference(
						nativeWorldVector(domain, point, velocity),
						nativeWorldVector(domain, lift, [velocity[0], -velocity[1]])
					)
				).toBeLessThan(1e-12);
				expect(nativeMetricNorm(metric, velocity)).toBeCloseTo(
					nativeMetricNorm(liftMetric, [velocity[0], -velocity[1]]),
					12
				);
			}
		}
	);
	it.each([mobius, klein])(
		'carries orientation-cover parity through repeated positive and negative $shape seams',
		(domain) => {
			for (const crossings of [-5, -4, -1, 0, 1, 2, 7]) {
				const unwrapped = { u: crossings * 2 * Math.PI + 0.2, v: 0.3 },
					state = canonicalNative(domain, unwrapped, [0.1, 0.2], 1),
					sign = crossings % 2 === 0 ? 1 : -1;
				expect(state.point.u).toBeCloseTo(0.2, 12);
				expect(state.point.v).toBeCloseTo(sign * 0.3, 12);
				expect(state.coordinateVelocity).toEqual([0.1, sign * 0.2]);
				expect(state.orientation).toBe(sign);
				const liftedNormal = normal(domain, state.point).map(
					(v) => v * state.orientation
				) as unknown as Vec3;
				expect(difference(liftedNormal, normal(domain, unwrapped))).toBeLessThan(1e-12);
			}
		}
	);
	it('checks the legitimate noncommuting Klein deck generators and both periodic corners', () => {
		const A = (p: NativePoint): NativePoint => ({ u: p.u + 2 * Math.PI, v: -p.v }),
			inverseA = (p: NativePoint): NativePoint => ({ u: p.u - 2 * Math.PI, v: -p.v }),
			B = (p: NativePoint): NativePoint => ({ u: p.u, v: p.v + 2 * Math.PI });
		const point = { u: 0.4, v: 0.7 },
			aba = A(B(inverseA(point)));
		expect(aba.u).toBeCloseTo(point.u, 12);
		expect(aba.v).toBeCloseTo(point.v - 2 * Math.PI, 12);
		expect(B(A(point)).v).not.toBe(A(B(point)).v);
		expect(canonicalNative(klein, { u: 2 * Math.PI, v: Math.PI }).point).toEqual({
			u: 0,
			v: -Math.PI
		});
	});
	it('proves regularity with a conservative analytic Klein metric eigenvalue lower bound', () => {
		for (const ratio of [3, 4, 6, 10]) {
			const domain = { shape: 'klein', majorRadius: ratio, sectionScale: 1 } as const,
				bound = kleinMetricEigenvalueLowerBound(domain);
			expect(bound).toBeGreaterThan(0);
			for (let i = 0; i < 40; i++)
				for (let j = 0; j < 40; j++) {
					const { E, F, G } = nativeMetric(domain, {
						u: (i * 2 * Math.PI) / 40,
						v: (j * 2 * Math.PI) / 40
					});
					const least = (E + G - Math.hypot(E - G, 2 * F)) / 2;
					expect(least).toBeGreaterThanOrEqual(bound - 1e-12);
				}
		}
	});
	it('retains distinct native sheets at the figure-eight immersion crossing', () => {
		const a = { u: 1.2, v: 0 },
			b = { u: 1.2, v: Math.PI };
		expect(difference(nativePoint(klein, a), nativePoint(klein, b))).toBeLessThan(1e-12);
		expect(nativeMidpointRelation(klein, a, b).distance).toBeGreaterThan(1);
		const agents = [
			{ id: 1, point: a },
			{ id: 2, point: b }
		];
		expect(nativeAllPairs(klein, agents, 0, 0.1)).toHaveLength(0);
		expect(nativeGrid(klein, agents, 0.1).query(0)).toHaveLength(0);
	});
	it.each([mobius, klein])(
		'matches complete native all-pairs across $shape seams without capacity truncation',
		(domain) => {
			let seed = 511;
			const random = () => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				return seed / 2 ** 32;
			};
			const agents: NativePrototypeAgent[] = Array.from({ length: 900 }, (_, i) => ({
				id: i + 1,
				point: {
					u: random() * 2 * Math.PI,
					v: domain.shape === 'mobius' ? 2 * random() - 1 : 2 * Math.PI * random() - Math.PI
				}
			}));
			const seam = domain.shape === 'mobius' ? 0.4 : Math.PI - 0.01;
			agents.push(
				{ id: 901, point: { u: 0.001, v: seam } },
				{ id: 902, point: { u: 2 * Math.PI - 0.001, v: -seam } }
			);
			for (let i = 0; i < 120; i++) agents.push({ id: 903 + i, point: { u: 0.001, v: seam } });
			const query = nativePrototypeRange(domain),
				grid = nativeGrid(domain, agents, query);
			for (let index = 0; index < agents.length; index += 23)
				expect(grid.query(index)).toEqual(nativeAllPairs(domain, agents, index, query));
			expect(grid.query(900)).toEqual(nativeAllPairs(domain, agents, 900, query));
			expect(grid.query(900)).toContain(902);
			expect(grid.query(900).length).toBeGreaterThan(120);
			expect(new Set(grid.query(900)).size).toBe(grid.query(900).length);
		}
	);
	it.each([mobius, klein])(
		'retains symmetric local midpoint classification within $shape coordinate search bounds',
		(domain) => {
			const from = { u: 0.001, v: 0.35 },
				to = { u: 2 * Math.PI - 0.002, v: -0.34 },
				query = nativePrototypeRange(domain),
				relation = nativeMidpointRelation(domain, from, to),
				reverse = nativeMidpointRelation(domain, to, from);
			expect(relation.distance).toBeCloseTo(reverse.distance, 12);
			expect(relation.distance).toBeLessThan(query);
			const [reachU, reachV] = nativeCoordinateReach(domain, query);
			expect(Math.abs(relation.displacement[0])).toBeLessThan(reachU);
			expect(Math.abs(relation.displacement[1])).toBeLessThan(reachV);
		}
	);
});
