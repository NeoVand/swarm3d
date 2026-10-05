import type { Vec2 } from '#lib/model/types';
import {
	assertTorusParameters,
	torusApproximateRelation,
	torusHeight,
	torusLocalRange,
	torusShortAngle
} from '#lib/model/torus';
import type {
	TorusParameters,
	TorusChartPoint,
	TorusChartState,
	TorusIntegratedState,
	TorusLocalRelation
} from '#lib/model/torus';
export * from '#lib/model/torus';

/**
 * High-accuracy CPU research oracle; intentionally absent from the public model
 * barrel and live geometry imports. The induced metric and geodesic equations
 * are based on Joel Feldman, Torus Geodesics (2007):
 * https://www.math.ubc.ca/~feldman/m428/torus_geodesics.pdf
 * and Robert T. Jantzen, Geodesics on the Torus (2012):
 * https://homepage.villanova.edu/robert.jantzen/notes/torus/torusgeos.pdf
 * Our charts exchange their Z axis for Y and their tube/azimuth angle labels.
 * The midpoint approximation and broadphase bound are derived in torus.ts.
 */
export interface TorusReferenceRelation extends TorusLocalRelation {
	iterations: number;
	/** Endpoint residual in physical units; this is a local shooting solution. */
	residual: number;
}

function finite(values: readonly number[]): void {
	if (values.some((value) => !Number.isFinite(value)))
		throw new Error('Torus geometry requires finite values.');
}
type DifferentialState = readonly [number, number, number, number, number];
function derivative(surface: TorusParameters, state: DifferentialState): DifferentialState {
	const [theta, , a, b] = state,
		height = torusHeight(surface, theta),
		connection = Math.sin(theta) / height;
	return [
		a / surface.tubeRadius,
		b / height,
		-connection * b * b,
		connection * a * b,
		connection * b
	];
}
function plus(
	state: DifferentialState,
	slope: DifferentialState,
	amount: number
): DifferentialState {
	return state.map((value, axis) => value + amount * slope[axis]) as unknown as DifferentialState;
}
function rk4Step(
	surface: TorusParameters,
	state: DifferentialState,
	dt: number
): DifferentialState {
	const a = derivative(surface, state),
		b = derivative(surface, plus(state, a, dt / 2)),
		c = derivative(surface, plus(state, b, dt / 2)),
		d = derivative(surface, plus(state, c, dt));
	return state.map(
		(value, axis) => value + (dt / 6) * (a[axis] + 2 * b[axis] + 2 * c[axis] + d[axis])
	) as unknown as DifferentialState;
}
/** High-accuracy numerical free-motion reference, retaining unwrapped chart angles. */
export function torusIntegrateReference(
	surface: TorusParameters,
	initial: TorusChartState,
	duration: number,
	steps = Math.max(
		32,
		Math.ceil((Math.abs(duration) * Math.hypot(...initial.velocity)) / (0.005 * surface.tubeRadius))
	)
): TorusIntegratedState {
	assertTorusParameters(surface);
	finite([initial.theta, initial.phi, ...initial.velocity, duration]);
	if (!Number.isSafeInteger(steps) || steps < 1)
		throw new Error('Torus integration needs a positive integer step count.');
	let state: DifferentialState = [initial.theta, initial.phi, ...initial.velocity, 0];
	for (let step = 0; step < steps; step++) state = rk4Step(surface, state, duration / steps);
	return {
		theta: state[0],
		phi: state[1],
		velocity: [state[2], state[3]],
		transportAngle: state[4]
	};
}

/**
 * Local shooting reference. Solves the nearby endpoint problem, not the global
 * torus cut locus or all possible winding geodesics. Convergence is checked in
 * physical units and failures throw instead of returning an unchecked result.
 */
export function torusReferenceRelation(
	surface: TorusParameters,
	from: TorusChartPoint,
	to: TorusChartPoint,
	steps = 96
): TorusReferenceRelation {
	const approximate = torusApproximateRelation(surface, from, to);
	if (approximate.distance > torusLocalRange(surface) * (1 + 1e-10))
		throw new Error('Torus shooting is restricted to the audited local radius.');
	// Rotational symmetry lets shooting start at φ=0. Avoid subtracting two
	// large absolute φ coordinates when the major/tube radius ratio is large.
	const origin = { theta: torusShortAngle(from.theta), phi: 0 };
	const target = {
		theta: origin.theta + torusShortAngle(to.theta - from.theta),
		phi: torusShortAngle(to.phi - from.phi)
	};
	const targetHeight = torusHeight(surface, target.theta),
		tolerance = 1e-11 * surface.tubeRadius;
	const integrate = (velocity: Vec2) =>
		torusIntegrateReference(surface, { ...origin, velocity }, 1, steps);
	const residual = (state: TorusChartPoint): Vec2 => [
		(state.theta - target.theta) * surface.tubeRadius,
		(state.phi - target.phi) * targetHeight
	];
	let velocity = approximate.displacement;
	for (let iteration = 0; iteration < 12; iteration++) {
		const endpoint = integrate(velocity),
			error = residual(endpoint),
			errorLength = Math.hypot(...error);
		if (errorLength <= tolerance)
			return {
				distance: Math.hypot(...velocity),
				displacement: velocity,
				transportAngle: endpoint.transportAngle,
				iterations: iteration,
				residual: errorLength
			};
		const epsilon = 1e-5 * Math.max(surface.tubeRadius, approximate.distance);
		const columns = [0, 1].map((axis) => {
			const upper = [...velocity] as [number, number],
				lower = [...velocity] as [number, number];
			upper[axis] += epsilon;
			lower[axis] -= epsilon;
			const a = residual(integrate(upper)),
				b = residual(integrate(lower));
			return [(a[0] - b[0]) / (2 * epsilon), (a[1] - b[1]) / (2 * epsilon)] as Vec2;
		});
		const determinant = columns[0][0] * columns[1][1] - columns[1][0] * columns[0][1];
		if (Math.abs(determinant) < 1e-10)
			throw new Error('Torus local shooting Jacobian is singular.');
		const correction: Vec2 = [
			(error[0] * columns[1][1] - error[1] * columns[1][0]) / determinant,
			(columns[0][0] * error[1] - columns[0][1] * error[0]) / determinant
		];
		let accepted = false;
		for (let weight = 1; weight >= 1 / 64; weight /= 2) {
			const candidate: Vec2 = [
				velocity[0] - weight * correction[0],
				velocity[1] - weight * correction[1]
			];
			if (Math.hypot(...residual(integrate(candidate))) < errorLength) {
				velocity = candidate;
				accepted = true;
				break;
			}
		}
		if (!accepted) throw new Error('Torus local shooting failed to improve its endpoint residual.');
	}
	throw new Error('Torus local shooting did not converge.');
}

/** Accurate numerical length of the chosen straight chart path, not shortest distance. */
export function torusChartPathLength(
	surface: TorusParameters,
	from: TorusChartPoint,
	to: TorusChartPoint,
	intervals = 128
): number {
	assertTorusParameters(surface);
	if (!Number.isSafeInteger(intervals) || intervals < 2 || intervals % 2 !== 0)
		throw new Error('Torus Simpson integration needs a positive even interval count.');
	const theta = torusShortAngle(to.theta - from.theta),
		phi = torusShortAngle(to.phi - from.phi);
	const speed = (t: number) =>
		Math.hypot(surface.tubeRadius * theta, torusHeight(surface, from.theta + theta * t) * phi);
	let total = speed(0) + speed(1);
	for (let index = 1; index < intervals; index++)
		total += (index % 2 ? 4 : 2) * speed(index / intervals);
	return total / (3 * intervals);
}
