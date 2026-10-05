import { describe, expect, it } from 'vitest';
import type { Vec2, Vec3 } from '#lib/model/types';
import {
	assertTorusParameters,
	torusApproximateRelation,
	torusArea,
	torusBroadphaseRadius,
	torusChartPathLength,
	torusChartTransportAngle,
	torusFrame,
	torusHeight,
	torusIntegrateMidpoint,
	torusIntegrateReference,
	torusLocalRange,
	torusNormal,
	torusPoint,
	torusReferenceRelation,
	torusRotate,
	torusShortAngle,
	torusWorldVector
} from '#lib/model/torus-reference';
import type { TorusChartPoint, TorusParameters } from '#lib/model/torus-reference';

const vectorAngle = (a: Vec2, b: Vec2): number =>
	Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
const difference = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const chord = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a: Vec3, b: Vec3): number => a.reduce((sum, value, i) => sum + value * b[i], 0);
function endpointAtApproximateDistance(
	surface: TorusParameters,
	from: TorusChartPoint,
	distance: number,
	orientation: number
): TorusChartPoint {
	const theta = (distance * Math.cos(orientation)) / surface.tubeRadius;
	return {
		theta: from.theta + theta,
		phi:
			from.phi + (distance * Math.sin(orientation)) / torusHeight(surface, from.theta + theta / 2)
	};
}

describe('induced torus metric and high-accuracy reference', () => {
	it('requires an embedded ring torus with the declared shape/range envelope', () => {
		for (const surface of [
			{ majorRadius: 1.99, tubeRadius: 1 },
			{ majorRadius: 3, tubeRadius: 0 },
			{ majorRadius: Infinity, tubeRadius: 1 }
		])
			expect(() => assertTorusParameters(surface)).toThrow();
		expect(torusLocalRange({ majorRadius: 2, tubeRadius: 1 })).toBe(0.3);
		expect(torusLocalRange({ majorRadius: 20, tubeRadius: 3 })).toBeCloseTo(0.9, 12);
		expect(() => torusBroadphaseRadius({ majorRadius: 2, tubeRadius: 1 }, 0.3001)).toThrow();
		expect(() =>
			torusReferenceRelation(
				{ majorRadius: 2, tubeRadius: 1 },
				{ theta: 0, phi: 0 },
				{ theta: 0.4, phi: 0 }
			)
		).toThrow(/local radius/);
	});
	it('embeds the induced metric, frame, outward normal and exact area', () => {
		const surface = { majorRadius: 3, tubeRadius: 1.4 },
			point = { theta: 1.8, phi: -2.4 },
			[theta, phi] = torusFrame(point),
			normal = torusNormal(point);
		for (const vector of [theta, phi, normal]) expect(Math.hypot(...vector)).toBeCloseTo(1, 13);
		expect(dot(theta, phi)).toBeCloseTo(0, 13);
		expect(dot(theta, normal)).toBeCloseTo(0, 13);
		expect(dot(phi, normal)).toBeCloseTo(0, 13);
		const step = 1e-6,
			position = torusPoint(surface, point);
		expect(
			chord(torusPoint(surface, { ...point, theta: point.theta + step }), position) / step
		).toBeCloseTo(surface.tubeRadius, 6);
		expect(
			chord(torusPoint(surface, { ...point, phi: point.phi + step }), position) / step
		).toBeCloseTo(torusHeight(surface, point.theta), 6);
		expect(Math.hypot(...torusWorldVector(point, [3, -4]))).toBeCloseTo(5, 12);
		expect(torusArea(surface)).toBeCloseTo(4 * Math.PI ** 2 * 3 * 1.4, 12);
	});
	it('preserves energy, Clairaut momentum and transported tangent direction without renormalization', () => {
		const surface = { majorRadius: 2, tubeRadius: 1 };
		for (const theta of [0, 0.7, Math.PI / 2, Math.PI - 0.01, -Math.PI + 0.01]) {
			const initial = { theta, phi: Math.PI - 0.03, velocity: [0.8, -0.6] as Vec2 },
				end = torusIntegrateReference(surface, initial, 8, 1600);
			expect(Math.hypot(...end.velocity)).toBeCloseTo(1, 10);
			expect(torusHeight(surface, end.theta) * end.velocity[1]).toBeCloseTo(
				torusHeight(surface, theta) * initial.velocity[1],
				10
			);
			expect(
				difference(end.velocity, torusRotate(initial.velocity, end.transportAngle))
			).toBeLessThan(1e-10);
			const backward = torusIntegrateReference(surface, end, -8, 1600);
			expect(Math.abs(backward.theta - theta)).toBeLessThan(1e-9);
			expect(Math.abs(backward.phi - initial.phi)).toBeLessThan(1e-9);
		}
	});
	it('reproduces meridians and inner/outer equators through repeated chart seams', () => {
		const surface = { majorRadius: 2.5, tubeRadius: 1.25 };
		const meridian = torusIntegrateReference(
			surface,
			{ theta: 2.9, phi: 0.7, velocity: [3, 0] },
			9
		);
		expect(meridian.theta).toBeCloseTo(2.9 + (3 * 9) / 1.25, 10);
		expect(meridian.phi).toBeCloseTo(0.7, 12);
		for (const theta of [0, Math.PI]) {
			const equator = torusIntegrateReference(surface, { theta, phi: 3, velocity: [0, -3] }, 9);
			expect(equator.theta).toBeCloseTo(theta, 10);
			expect(equator.phi).toBeCloseTo(3 - (3 * 9) / torusHeight(surface, theta), 10);
		}
	});
	it('checks shooting convergence independently by doubling the RK4 reference resolution', () => {
		for (const majorRadius of [2, 3, 10]) {
			const surface = { majorRadius, tubeRadius: 1 };
			for (const theta of [0, 0.7, Math.PI / 2, Math.PI, -Math.PI + 0.03]) {
				for (const angle of [0.2, 1.1, 2.3]) {
					const from = { theta, phi: Math.PI - 0.01 },
						to = endpointAtApproximateDistance(surface, from, 0.3, angle),
						low = torusReferenceRelation(surface, from, to, 48),
						high = torusReferenceRelation(surface, from, to, 192);
					expect(low.residual).toBeLessThan(1e-11);
					expect(high.residual).toBeLessThan(1e-11);
					expect(Math.abs(low.distance - high.distance)).toBeLessThan(1e-11);
					expect(vectorAngle(low.displacement, high.displacement)).toBeLessThan(1e-10);
					expect(Math.abs(low.transportAngle - high.transportAngle)).toBeLessThan(1e-10);
				}
			}
		}
	});
	it('reverses the same local geodesic displacement and path transport', () => {
		const surface = { majorRadius: 2, tubeRadius: 1 };
		for (const theta of [0, 0.7, Math.PI / 2, Math.PI - 0.1]) {
			for (const angle of [0.1, 0.8, 1.6, 2.4]) {
				const from = { theta, phi: Math.PI - 0.04 },
					to = endpointAtApproximateDistance(surface, from, 0.299, angle),
					forward = torusReferenceRelation(surface, from, to),
					reverse = torusReferenceRelation(surface, to, from);
				expect(forward.distance).toBeCloseTo(reverse.distance, 10);
				expect(forward.transportAngle).toBeCloseTo(-reverse.transportAngle, 10);
				expect(
					difference(
						forward.displacement,
						torusRotate(reverse.displacement, -forward.transportAngle).map(
							(v) => -v
						) as unknown as Vec2
					)
				).toBeLessThan(1e-10);
			}
		}
	});
});

describe('audited local torus candidate', () => {
	it('uses the exact connection integral and the correct first-half back transport', () => {
		const surface = { majorRadius: 2, tubeRadius: 1 },
			from = { theta: 0.9, phi: 3.1 },
			to = { theta: 1.1, phi: -3.06 },
			forward = torusApproximateRelation(surface, from, to),
			reverse = torusApproximateRelation(surface, to, from);
		expect(forward.distance).toBeCloseTo(reverse.distance, 13);
		expect(forward.transportAngle).toBeCloseTo(-reverse.transportAngle, 13);
		expect(
			difference(
				forward.displacement,
				torusRotate(reverse.displacement, -forward.transportAngle).map((v) => -v) as unknown as Vec2
			)
		).toBeLessThan(1e-13);
		const dTheta = torusShortAngle(to.theta - from.theta),
			dPhi = torusShortAngle(to.phi - from.phi),
			middle = { theta: from.theta + dTheta / 2, phi: from.phi + dPhi / 2 },
			firstHalf = torusChartTransportAngle(from, middle);
		expect(Math.abs(firstHalf - forward.transportAngle / 2)).toBeGreaterThan(1e-4);
		const halfway = torusRotate(forward.displacement, firstHalf);
		expect(difference(halfway, [dTheta, torusHeight(surface, middle.theta) * dPhi])).toBeLessThan(
			1e-13
		);
	});
	it('bounds distance, direction and transport error over rims, seams, shape ratios and orientations', () => {
		const maxima = { relativeDistance: 0, logAngle: 0, transportAngle: 0, referenceResidual: 0 },
			worst: Record<string, unknown> = {};
		let samples = 0;
		for (const ratio of [2, 2.01, 2.5, 3, 5, 10]) {
			const surface = { majorRadius: ratio, tubeRadius: 1 };
			for (let meridian = 0; meridian < 24; meridian++) {
				const theta = (2 * Math.PI * meridian) / 24 - Math.PI;
				for (let orientation = 0; orientation < 32; orientation++) {
					for (const fraction of [0.1, 0.5, 1]) {
						const from = { theta, phi: orientation % 2 ? Math.PI - 0.013 : -Math.PI + 0.017 },
							to = endpointAtApproximateDistance(
								surface,
								from,
								torusLocalRange(surface) * fraction,
								(orientation * 2 * Math.PI) / 32
							),
							candidate = torusApproximateRelation(surface, from, to),
							reference = torusReferenceRelation(surface, from, to),
							error = {
								relativeDistance: Math.abs(candidate.distance / reference.distance - 1),
								logAngle: vectorAngle(candidate.displacement, reference.displacement),
								transportAngle: Math.abs(candidate.transportAngle - reference.transportAngle),
								referenceResidual: reference.residual
							};
						for (const key of Object.keys(maxima) as (keyof typeof maxima)[]) {
							if (error[key] > maxima[key]) {
								maxima[key] = error[key];
								worst[key] = { ratio, theta, orientation, fraction };
							}
						}
						const reverse = torusApproximateRelation(surface, to, from);
						expect(candidate.distance).toBeCloseTo(reverse.distance, 12);
						expect(candidate.transportAngle).toBeCloseTo(-reverse.transportAngle, 12);
						expect(
							difference(
								candidate.displacement,
								torusRotate(reverse.displacement, -candidate.transportAngle).map(
									(v) => -v
								) as unknown as Vec2
							)
						).toBeLessThan(1e-12);
						samples++;
					}
				}
			}
		}
		console.info('Torus local approximation audit', JSON.stringify({ samples, maxima, worst }));
		expect(maxima.relativeDistance).toBeLessThan(0.01);
		expect(maxima.logAngle).toBeLessThan(0.02);
		expect(maxima.transportAngle).toBeLessThan(0.02);
		expect(maxima.referenceResidual).toBeLessThan(1e-11);
	}, 30000);
	it('audits continuous random positions and physical scales, including very thin tori', () => {
		let seed = 512791;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		const maxima = { relativeDistance: 0, logAngle: 0, transportAngle: 0 };
		for (let sample = 0; sample < 10000; sample++) {
			const ratio = sample % 3 ? 2 + 18 * random() : 20 * 50000 ** random(),
				radius = 10 ** (6 * random() - 3),
				surface = { majorRadius: radius * ratio, tubeRadius: radius },
				from = { theta: 2 * Math.PI * random() - Math.PI, phi: 2 * Math.PI * random() - Math.PI },
				to = endpointAtApproximateDistance(
					surface,
					from,
					torusLocalRange(surface) * (0.01 + 0.98 * random()),
					2 * Math.PI * random()
				),
				candidate = torusApproximateRelation(surface, from, to),
				reference = torusReferenceRelation(surface, from, to);
			maxima.relativeDistance = Math.max(
				maxima.relativeDistance,
				Math.abs(candidate.distance / reference.distance - 1)
			);
			maxima.logAngle = Math.max(
				maxima.logAngle,
				vectorAngle(candidate.displacement, reference.displacement)
			);
			maxima.transportAngle = Math.max(
				maxima.transportAngle,
				Math.abs(candidate.transportAngle - reference.transportAngle)
			);
			expect(reference.residual).toBeLessThanOrEqual(1e-11 * radius);
		}
		console.info(
			'Torus randomized scale/shape audit',
			JSON.stringify({
				samples: 10000,
				ratioRange: [2, 1000000],
				tubeRadiusRange: [0.001, 1000],
				maxima
			})
		);
		expect(maxima.relativeDistance).toBeLessThan(0.01);
		expect(maxima.logAngle).toBeLessThan(0.02);
		expect(maxima.transportAngle).toBeLessThan(0.02);
	}, 30000);
	it('keeps the analytic embedded broadphase conservative in a deterministic numerical stress test', () => {
		let seed = 73491,
			maxPathOverApproximate = 0;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		for (let sample = 0; sample < 10000; sample++) {
			const surface = { majorRadius: 2 + 18 * random(), tubeRadius: 1 },
				from = { theta: random() * 2 * Math.PI - Math.PI, phi: random() * 2 * Math.PI - Math.PI },
				query = torusLocalRange(surface),
				to = endpointAtApproximateDistance(
					surface,
					from,
					query * (0.01 + 0.99 * random()),
					random() * 2 * Math.PI
				),
				approximate = torusApproximateRelation(surface, from, to),
				length = torusChartPathLength(surface, from, to, 32),
				padding =
					approximate.distance *
					(1 + approximate.distance / (2 * (surface.majorRadius - surface.tubeRadius)));
			expect(chord(torusPoint(surface, from), torusPoint(surface, to))).toBeLessThanOrEqual(
				length + 1e-12
			);
			expect(length).toBeLessThanOrEqual(padding + 1e-12);
			expect(padding).toBeLessThanOrEqual(torusBroadphaseRadius(surface, query) + 1e-12);
			maxPathOverApproximate = Math.max(maxPathOverApproximate, length / approximate.distance);
		}
		console.info(
			'Torus broadphase audit',
			JSON.stringify({ samples: 10000, maxPathOverApproximate })
		);
	});
	it('preserves seam representatives, including exact half-period ties and repeated windings', () => {
		expect(torusShortAngle(Math.PI)).toBe(Math.PI);
		expect(torusShortAngle(-Math.PI)).toBe(-Math.PI);
		expect(torusShortAngle(5 * Math.PI)).toBeCloseTo(Math.PI, 13);
		expect(torusShortAngle(-5 * Math.PI)).toBeCloseTo(-Math.PI, 13);
		const surface = { majorRadius: 2, tubeRadius: 1 },
			from = { theta: Math.PI - 0.02, phi: Math.PI - 0.04 },
			to = { theta: -Math.PI + 0.03, phi: -Math.PI + 0.02 };
		const relation = torusApproximateRelation(surface, from, to),
			unwrapped = torusApproximateRelation(surface, from, {
				theta: to.theta + 2 * Math.PI,
				phi: to.phi + 2 * Math.PI
			});
		expect(difference(relation.displacement, unwrapped.displacement)).toBeLessThan(1e-13);
		expect(relation.distance).toBeCloseTo(unwrapped.distance, 13);
		expect(relation.transportAngle).toBeCloseTo(unwrapped.transportAngle, 13);
	});
	it('scales physical distances and displacements without changing angles', () => {
		const from = { theta: 2.9, phi: -3.1 },
			to = { theta: 3.02, phi: -3.02 },
			a = torusReferenceRelation({ majorRadius: 2, tubeRadius: 1 }, from, to),
			b = torusReferenceRelation({ majorRadius: 5, tubeRadius: 2.5 }, from, to);
		expect(b.distance).toBeCloseTo(2.5 * a.distance, 11);
		expect(
			difference(b.displacement, [2.5 * a.displacement[0], 2.5 * a.displacement[1]])
		).toBeLessThan(1e-11);
		expect(b.transportAngle).toBeCloseTo(a.transportAngle, 11);
	});
});

describe('speed-preserving torus midpoint motion candidate', () => {
	it('converges at second order against the RK4 reference, including the inner rim and seams', () => {
		let worstFinePosition = 0,
			worstFineHeading = 0;
		for (const ratio of [2, 3, 10]) {
			const surface = { majorRadius: ratio, tubeRadius: 1 };
			for (const theta of [0, 0.8, Math.PI / 2, Math.PI - 0.03]) {
				for (const angle of [0.2, 1.1, 2.4]) {
					const initial = {
							theta,
							phi: Math.PI - 0.02,
							velocity: [Math.cos(angle), Math.sin(angle)] as Vec2
						},
						reference = torusIntegrateReference(surface, initial, 2, 1600),
						coarse = torusIntegrateMidpoint(surface, initial, 2, 40),
						medium = torusIntegrateMidpoint(surface, initial, 2, 80),
						fine = torusIntegrateMidpoint(surface, initial, 2, 160);
					const positionError = (point: TorusChartPoint) =>
						chord(torusPoint(surface, point), torusPoint(surface, reference));
					expect(positionError(medium)).toBeLessThan(positionError(coarse) * 0.27);
					expect(positionError(fine)).toBeLessThan(positionError(medium) * 0.27);
					expect(Math.hypot(...fine.velocity)).toBeCloseTo(1, 12);
					expect(dot(torusWorldVector(fine, fine.velocity), torusNormal(fine))).toBeCloseTo(0, 12);
					worstFinePosition = Math.max(worstFinePosition, positionError(fine));
					worstFineHeading = Math.max(
						worstFineHeading,
						vectorAngle(fine.velocity, reference.velocity)
					);
				}
			}
		}
		console.info(
			'Torus midpoint refinement audit',
			JSON.stringify({ travel: 2, fineStepTravel: 0.0125, worstFinePosition, worstFineHeading })
		);
		expect(worstFinePosition).toBeLessThan(0.0001);
		expect(worstFineHeading).toBeLessThan(0.0001);
	});
	it('is reversible at a fixed step count and rejects steps beyond the tested motion envelope', () => {
		const surface = { majorRadius: 2, tubeRadius: 1 },
			initial = { theta: 2.7, phi: 3.1, velocity: [0.6, 0.8] as Vec2 },
			end = torusIntegrateMidpoint(surface, initial, 3, 120),
			back = torusIntegrateMidpoint(surface, end, -3, 120);
		expect(back.theta).toBeCloseTo(initial.theta, 11);
		expect(back.phi).toBeCloseTo(initial.phi, 11);
		expect(difference(back.velocity, initial.velocity)).toBeLessThan(1e-11);
		expect(() => torusIntegrateMidpoint(surface, initial, 1, 1)).toThrow(/0.05r/);
	});
});
