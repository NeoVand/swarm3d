import type { Vec2, Vec3 } from '#lib/model/types';

/**
 * Induced ring-torus helpers. Physical components (a,b) use the orthonormal
 * frame (∂θ/r,∂φ/H), H=R+r cosθ, with world Y as the revolution axis.
 * Distance and log are local midpoint approximations; neighbor transport is
 * exact along the chosen straight chart path, not a shortest-geodesic claim.
 *
 * CPU audit at D≤0.3r: 23,824 pairs, observed distance error≤0.125%, direction
 * error≤0.00304 rad, transport-angle error≤0.000821 rad. These observations are
 * not uniform error theorems. Production also bounds 2≤R/r≤10 and r≥1.
 * Geodesic/RK4 shooting and primary references live in torus-reference.ts;
 * hot geometry paths do not import that reference module.
 */
export interface TorusParameters {
	majorRadius: number;
	tubeRadius: number;
}
export interface TorusChartPoint {
	theta: number;
	phi: number;
}
export interface TorusChartState extends TorusChartPoint {
	velocity: Vec2;
}
export interface TorusIntegratedState extends TorusChartState {
	/** Parallel-transport rotation in the orthonormal frame, along this path. */
	transportAngle: number;
}
export interface TorusLocalRelation {
	distance: number;
	/** Physical tangent displacement at the observer, in its (θ,φ) frame. */
	displacement: Vec2;
	/** Rotation for transporting a tangent vector from the observer to target. */
	transportAngle: number;
}
function finite(values: readonly number[]): void {
	if (values.some((value) => !Number.isFinite(value)))
		throw new Error('Torus geometry requires finite values.');
}
export function assertTorusParameters(surface: TorusParameters): void {
	finite([surface.majorRadius, surface.tubeRadius]);
	if (surface.tubeRadius <= 0 || surface.majorRadius < 2 * surface.tubeRadius)
		throw new Error('Torus prototype requires a positive tube radius and R ≥ 2r.');
}
export function torusLocalRange(surface: TorusParameters): number {
	assertTorusParameters(surface);
	return 0.3 * Math.min(surface.tubeRadius, surface.majorRadius - surface.tubeRadius);
}
export const torusHeight = (surface: TorusParameters, theta: number): number =>
	surface.majorRadius + surface.tubeRadius * Math.cos(theta);

/** Exact half-period ties keep their original sign. No tie occurs in the local envelope. */
export function torusShortAngle(angle: number): number {
	if (angle > Math.PI) return angle - Math.ceil((angle - Math.PI) / (2 * Math.PI)) * 2 * Math.PI;
	if (angle < -Math.PI) return angle + Math.ceil((-Math.PI - angle) / (2 * Math.PI)) * 2 * Math.PI;
	return angle;
}
const sinc = (angle: number): number =>
	Math.abs(angle) < 1e-4
		? 1 - angle ** 2 / 6 + angle ** 4 / 120 - angle ** 6 / 5040
		: Math.sin(angle) / angle;

export function torusRotate(vector: Vec2, angle: number): Vec2 {
	const c = Math.cos(angle),
		s = Math.sin(angle);
	return [c * vector[0] - s * vector[1], s * vector[0] + c * vector[1]];
}
export function torusPoint(surface: TorusParameters, point: TorusChartPoint): Vec3 {
	const height = torusHeight(surface, point.theta);
	return [
		height * Math.cos(point.phi),
		surface.tubeRadius * Math.sin(point.theta),
		height * Math.sin(point.phi)
	];
}
/** Canonical closest chart point; signed-zero axes select +π rather than −π. */
export function torusChart(surface: TorusParameters, position: Vec3): TorusChartPoint {
	const angle = (y: number, x: number) => (y === 0 ? (x < 0 ? Math.PI : 0) : Math.atan2(y, x));
	return {
		theta: angle(position[1], Math.hypot(position[0], position[2]) - surface.majorRadius),
		phi: angle(position[2], position[0])
	};
}
export function torusFrame(point: TorusChartPoint): readonly [Vec3, Vec3] {
	return [
		[
			-Math.sin(point.theta) * Math.cos(point.phi),
			Math.cos(point.theta),
			-Math.sin(point.theta) * Math.sin(point.phi)
		],
		[-Math.sin(point.phi), 0, Math.cos(point.phi)]
	];
}
export function torusWorldVector(point: TorusChartPoint, components: Vec2): Vec3 {
	const [theta, phi] = torusFrame(point);
	return theta.map(
		(value, axis) => value * components[0] + phi[axis] * components[1]
	) as unknown as Vec3;
}
export function torusComponents(point: TorusChartPoint, vector: Vec3): Vec2 {
	const [theta, phi] = torusFrame(point);
	return [
		theta.reduce((sum, value, axis) => sum + value * vector[axis], 0),
		phi.reduce((sum, value, axis) => sum + value * vector[axis], 0)
	];
}
/** Exact induced-area draw: the coordinate area element is r·H(θ) dθ dφ. */
export function torusSampleChart(surface: TorusParameters, random: () => number): TorusChartPoint {
	assertTorusParameters(surface);
	const draw = () => {
		const value = random();
		if (!Number.isFinite(value) || value < 0 || value >= 1)
			throw new Error('Invalid torus random draw.');
		return value;
	};
	for (let attempt = 0; attempt < 4096; attempt++) {
		const theta = draw() * 2 * Math.PI - Math.PI;
		if (draw() * (surface.majorRadius + surface.tubeRadius) <= torusHeight(surface, theta))
			return { theta, phi: draw() * 2 * Math.PI - Math.PI };
	}
	throw new Error('Torus area sampler failed to obtain an accepted draw.');
}
export function torusNormal(point: TorusChartPoint): Vec3 {
	return [
		Math.cos(point.theta) * Math.cos(point.phi),
		Math.sin(point.theta),
		Math.cos(point.theta) * Math.sin(point.phi)
	];
}
export function torusArea(surface: TorusParameters): number {
	return 4 * Math.PI ** 2 * surface.majorRadius * surface.tubeRadius;
}

/**
 * Exact Levi-Civita transport along the short straight line in chart space.
 * A transported vector has a' = −sin θ · φ' b, b' = sin θ · φ' a, hence it
 * rotates by ∫ sin θ dφ. This path is generally not a geodesic.
 */
export function torusChartTransportAngle(from: TorusChartPoint, to: TorusChartPoint): number {
	const theta = torusShortAngle(to.theta - from.theta),
		phi = torusShortAngle(to.phi - from.phi);
	return phi * Math.sin(from.theta + theta / 2) * sinc(theta / 2);
}
/**
 * Symmetric local distance estimate, with exactly reversible path transport.
 * Midpoint displacement is transported back over the first half of the chart
 * path. Half of the whole connection integral would be wrong when θ varies.
 */
export function torusApproximateRelation(
	surface: TorusParameters,
	from: TorusChartPoint,
	to: TorusChartPoint
): TorusLocalRelation {
	assertTorusParameters(surface);
	finite([from.theta, from.phi, to.theta, to.phi]);
	const theta = torusShortAngle(to.theta - from.theta),
		phi = torusShortAngle(to.phi - from.phi);
	const midpoint: Vec2 = [
		surface.tubeRadius * theta,
		torusHeight(surface, from.theta + theta / 2) * phi
	];
	const firstHalf = (phi / 2) * Math.sin(from.theta + theta / 4) * sinc(theta / 4);
	return {
		distance: Math.hypot(...midpoint),
		displacement: torusRotate(midpoint, -firstHalf),
		transportAngle: torusChartTransportAngle(from, to)
	};
}
/** Inverse of the approximate local log, for contours of the same distance classifier. */
export function torusLocalPoint(
	surface: TorusParameters,
	from: TorusChartPoint,
	displacement: Vec2
): TorusChartPoint {
	assertTorusParameters(surface);
	finite([from.theta, from.phi, ...displacement]);
	if (Math.hypot(...displacement) > torusLocalRange(surface))
		throw new Error('Torus local point exceeds its interaction envelope.');
	let theta = displacement[0] / surface.tubeRadius,
		phi = displacement[1] / torusHeight(surface, from.theta);
	for (let iteration = 0; iteration < 24; iteration++) {
		const firstHalf = (phi / 2) * Math.sin(from.theta + theta / 4) * sinc(theta / 4);
		const middle = torusRotate(displacement, firstHalf);
		const nextTheta = middle[0] / surface.tubeRadius,
			nextPhi = middle[1] / torusHeight(surface, from.theta + nextTheta / 2);
		if (Math.hypot(nextTheta - theta, nextPhi - phi) < 1e-14)
			return { theta: from.theta + nextTheta, phi: from.phi + nextPhi };
		theta = nextTheta;
		phi = nextPhi;
	}
	throw new Error('Torus inverse local log did not converge.');
}

/**
 * Conservative embedded broadphase for neighbors classified by the midpoint
 * distance D ≤ query. Along the straight chart path, |H(t)−Hmid| ≤ r|Δθ|/2
 * ≤ D/2, Hmid ≥ R−r, so every path speed is ≤ D(1+D/[2(R−r)]).
 * Chord ≤ path length ≤ that bound. The padding is proven for the approximate
 * classifier, not a bound for all true geodesic neighbors at the same query.
 */
export function torusBroadphaseRadius(surface: TorusParameters, query: number): number {
	assertTorusParameters(surface);
	if (!Number.isFinite(query) || query <= 0 || query > torusLocalRange(surface))
		throw new Error('Torus query is outside the audited local radius.');
	return query * (1 + query / (2 * (surface.majorRadius - surface.tubeRadius)));
}

/**
 * Speed-preserving second-order candidate for free motion. The connection angle
 * and chart midpoint solve a small fixed-point problem; this is not exact Exp.
 * Each step must stay inside the conservative 0.05r travel envelope. Use more
 * steps for longer paths; explicit steps make refinement tests reproducible.
 */
export function torusIntegrateMidpoint(
	surface: TorusParameters,
	initial: TorusChartState,
	duration: number,
	steps = Math.max(
		1,
		Math.ceil((Math.abs(duration) * Math.hypot(...initial.velocity)) / (0.05 * surface.tubeRadius))
	)
): TorusIntegratedState {
	assertTorusParameters(surface);
	finite([initial.theta, initial.phi, ...initial.velocity, duration]);
	if (!Number.isSafeInteger(steps) || steps < 1)
		throw new Error('Torus integration needs a positive integer step count.');
	const dt = duration / steps;
	if (Math.abs(dt) * Math.hypot(...initial.velocity) > 0.05 * surface.tubeRadius * (1 + 1e-12))
		throw new Error('Torus midpoint integration requires travel ≤ 0.05r per step.');
	let theta = initial.theta,
		phi = initial.phi,
		velocity = initial.velocity,
		transportAngle = 0;
	for (let step = 0; step < steps; step++) {
		let angle = (dt * Math.sin(theta) * velocity[1]) / torusHeight(surface, theta);
		let converged = false;
		for (let iteration = 0; iteration < 16; iteration++) {
			const middleVelocity = torusRotate(velocity, angle / 2),
				middleTheta = theta + (dt * middleVelocity[0]) / (2 * surface.tubeRadius);
			const nextAngle =
				(dt * Math.sin(middleTheta) * middleVelocity[1]) / torusHeight(surface, middleTheta);
			if (Math.abs(nextAngle - angle) < 1e-14) {
				angle = nextAngle;
				converged = true;
				break;
			}
			angle = nextAngle;
		}
		if (!converged) throw new Error('Torus midpoint connection did not converge.');
		const middleVelocity = torusRotate(velocity, angle / 2),
			middleTheta = theta + (dt * middleVelocity[0]) / (2 * surface.tubeRadius);
		theta += (dt * middleVelocity[0]) / surface.tubeRadius;
		phi += (dt * middleVelocity[1]) / torusHeight(surface, middleTheta);
		velocity = torusRotate(velocity, angle);
		transportAngle += angle;
	}
	return { theta, phi, velocity, transportAngle };
}

/** World-space free motion; prior steering state follows this actual integrated path. */
export function torusAdvanceWorld(
	surface: TorusParameters,
	position: Vec3,
	velocity: Vec3,
	dt: number,
	priorVelocity?: Vec3
): { position: Vec3; velocity: Vec3; transportedPriorVelocity?: Vec3 } {
	const chart = torusChart(surface, position);
	const result = torusIntegrateMidpoint(
		surface,
		{ ...chart, velocity: torusComponents(chart, velocity) },
		dt
	);
	return {
		position: torusPoint(surface, result),
		velocity: torusWorldVector(result, result.velocity),
		...(priorVelocity
			? {
					transportedPriorVelocity: torusWorldVector(
						result,
						torusRotate(torusComponents(chart, priorVelocity), result.transportAngle)
					)
				}
			: {})
	};
}
