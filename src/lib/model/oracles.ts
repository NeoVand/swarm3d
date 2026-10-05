import type {
	AgentMetrics,
	AgentState,
	Behavior,
	DirectedRule,
	NeighborRelation,
	SceneDefinition,
	Vec3
} from '#lib/model/types';
import {
	add,
	allPairsNeighbors,
	bearing,
	cross,
	dot,
	localFrame,
	magnitude,
	normalize,
	neighborhoodMeasure,
	scale,
	worldTransport,
	worldNormal,
	subtract
} from '#lib/model/geometry';
import { METRICS, METRIC_FIELDS, metricDifference, metricValue } from '#lib/model/metrics';
import { evaluateCurve } from '#lib/model/curves';
import { interactionRadii } from '#lib/model/interactions';
import { isTopologyWorld } from '#lib/model/topology-world';

function largestEigenvalue(
	a: number,
	b: number,
	c: number,
	d: number,
	e: number,
	f: number
): number {
	if (b === 0 && c === 0 && e === 0) return Math.max(a, d, f);
	const q = (a + d + f) / 3;
	const p = Math.sqrt(
		((a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * (b * b + c * c + e * e)) / 6
	);
	if (p < 1e-15) return q;
	const x = (a - q) / p,
		y = (d - q) / p,
		z = (f - q) / p;
	const xy = b / p,
		xz = c / p,
		yz = e / p;
	const determinant = x * y * z + 2 * xy * xz * yz - x * yz * yz - y * xz * xz - z * xy * xy;
	return q + 2 * p * Math.cos(Math.acos(Math.max(-1, Math.min(1, determinant / 2))) / 3);
}

/** Unsmoothed snapshot measurements; filters belong to an explicitly ticked subsequent stage. */
export function measureAllPairs(
	scene: SceneDefinition,
	agents: readonly AgentState[],
	previous?: readonly AgentState[],
	dt = scene.dynamics.fixedDt,
	query?: (index: number, radius: number) => NeighborRelation[],
	transportedPriorVelocities?: ReadonlyMap<number, Vec3>
): AgentMetrics[] {
	if (!Number.isFinite(dt) || dt <= 0) throw new Error('Measurement timestep must be positive.');
	const priorById = new Map(previous?.map((agent) => [agent.id, agent]));
	return agents.map((agent, index) => {
		const species = scene.species.find((item) => item.key === agent.speciesKey);
		if (!species) throw new Error(`Unknown agent species: ${agent.speciesKey}`);
		const neighbors = query
			? query(index, species.perception)
			: allPairsNeighbors(scene.world, agents, index, species.perception);
		const frame = localFrame(scene.world, agent.position, agent.triangle, agent.orientation);
		let meanDelta: Vec3 = [0, 0, 0],
			meanVelocity: Vec3 = [0, 0, 0],
			meanUnitVelocity: Vec3 = [0, 0, 0];
		let radialFlow = 0;
		const moments = [0, 0, 0, 0, 0, 0];
		for (const neighbor of neighbors) {
			meanDelta = add(meanDelta, neighbor.displacement);
			meanVelocity = add(meanVelocity, neighbor.velocity);
			meanUnitVelocity = add(meanUnitVelocity, normalize(neighbor.velocity));
			radialFlow += dot(
				normalize(subtract(neighbor.velocity, agent.velocity)),
				normalize(neighbor.displacement)
			);
			const delta =
				scene.world.kind === 'surface'
					? [dot(neighbor.displacement, frame[0]), dot(neighbor.displacement, frame[1]), 0]
					: neighbor.displacement;
			moments[0] += delta[0] ** 2;
			moments[1] += delta[0] * delta[1];
			moments[2] += delta[0] * delta[2];
			moments[3] += delta[1] ** 2;
			moments[4] += delta[1] * delta[2];
			moments[5] += delta[2] ** 2;
		}
		const count = neighbors.length;
		if (count) {
			meanDelta = scale(meanDelta, 1 / count);
			meanVelocity = scale(meanVelocity, 1 / count);
			meanUnitVelocity = scale(meanUnitVelocity, 1 / count);
			radialFlow /= count;
		}
		const trace = moments[0] + moments[3] + moments[5];
		const dimension = scene.world.kind === 'surface' ? 2 : 3;
		const largest =
			dimension === 2
				? (moments[0] + moments[3] + Math.hypot(moments[0] - moments[3], 2 * moments[1])) / 2
				: largestEigenvalue(moments[0], moments[1], moments[2], moments[3], moments[4], moments[5]);
		let acceleration = 0,
			turnRate = 0;
		const prior = priorById.get(agent.id);
		if (prior) {
			if (
				scene.world.kind === 'surface' &&
				(scene.world.shape === 'torus' || isTopologyWorld(scene.world)) &&
				!transportedPriorVelocities?.has(agent.id)
			)
				throw new Error(
					'Curved temporal metrics require prior velocity transported along the actual motion path.'
				);
			const previousVelocity =
				transportedPriorVelocities?.get(agent.id) ??
				worldTransport(
					scene.world,
					prior.velocity,
					prior.position,
					agent.position,
					prior.triangle,
					agent.triangle
				);
			acceleration = magnitude(subtract(agent.velocity, previousVelocity)) / dt;
			if (magnitude(previousVelocity) > 1e-9 && magnitude(agent.velocity) > 1e-9)
				turnRate =
					Math.atan2(
						magnitude(cross(previousVelocity, agent.velocity)),
						dot(previousVelocity, agent.velocity)
					) / dt;
		}
		const perceptionMeasure = neighborhoodMeasure(scene.world, species.perception);
		const centerNormal =
			scene.world.kind === 'surface'
				? worldNormal(scene.world, agent.position, agent.triangle, agent.orientation)
				: normalize(scene.dynamics.orbitAxis);
		const projectedVelocity = subtract(
			agent.velocity,
			scale(centerNormal, dot(agent.velocity, centerNormal))
		);
		const outward = scale(meanDelta, -1);
		const projectedOutward = subtract(outward, scale(centerNormal, dot(outward, centerNormal)));
		const centerOrbitAngle =
			magnitude(projectedVelocity) > 1e-7 && magnitude(projectedOutward) > 1e-7
				? (((Math.atan2(
						dot(cross(projectedVelocity, projectedOutward), centerNormal),
						dot(projectedVelocity, projectedOutward)
					) /
						(Math.PI * 2) +
						0.5) %
						1) +
						1) %
					1
				: 0;
		return {
			speed: magnitude(agent.velocity),
			turnRate,
			acceleration,
			neighborCount: count,
			density: count / perceptionMeasure,
			anisotropy:
				trace > 1e-15
					? Math.max(0, Math.min(1, ((dimension * largest) / trace - 1) / (dimension - 1)))
					: 0,
			polarization: magnitude(meanUnitVelocity),
			radialFlow,
			headingAzimuth: bearing(agent.velocity, [
				[1, 0, 0],
				[0, 0, -1]
			]),
			centerDistance: magnitude(meanDelta),
			centerBearing: bearing(meanDelta, frame),
			flowOrbit: bearing(meanVelocity, frame),
			centerOrbitAngle,
			centerRadialSpeed: dot(agent.velocity, normalize(meanDelta)),
			speedContrast: count
				? Math.abs(magnitude(agent.velocity) - magnitude(meanVelocity)) / species.speed
				: 0
		};
	});
}

export function resolveDirectedRule(
	scene: SceneDefinition,
	from: string,
	to: string
): DirectedRule | undefined {
	if (from === to) return undefined;
	return (
		scene.speciesRules.find((rule) => rule.from === from && rule.to === to) ??
		scene.speciesRules.find((rule) => rule.from === from && rule.to === '*')
	);
}
export function directedRuleRadius(scene: SceneDefinition, rule: DirectedRule): number {
	const species = scene.species.find((item) => item.key === rule.from);
	if (!species) throw new Error('Rule source species does not exist.');
	return rule.radius ?? species.perception;
}

export interface BehaviorForceInput {
	behavior: Behavior;
	displacement: Vec3;
	otherVelocity: Vec3;
	velocity: Vec3;
	normal: Vec3;
	speed: number;
	force: number;
	radius: number;
	pairKey?: number;
	spiralHandedness?: number;
}
const gpuUnit = (vector: Vec3): Vec3 => scale(vector, 1 / Math.max(magnitude(vector), 1e-7));
const limitedForce = (vector: Vec3, maximum: number): Vec3 =>
	scale(vector, Math.min(1, Math.max(0, maximum) / Math.max(magnitude(vector), 1e-7)));
function gpuHash(value: number): number {
	let hash = Math.imul((value ^ (value >>> 16)) >>> 0, 0x7feb352d) >>> 0;
	hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
	return (hash ^ (hash >>> 16)) >>> 0;
}
function gpuRandomUnit(key: number): Vec3 {
	const a = (gpuHash(key) & 0xffffff) / 16777216;
	const b = (gpuHash(key ^ 0xa511e9b3) & 0xffffff) / 16777216;
	const z = 2 * a - 1,
		radius = Math.sqrt(Math.max(0, 1 - z * z));
	return [radius * Math.cos(2 * Math.PI * b), z, radius * Math.sin(2 * Math.PI * b)];
}
/** Ordinary TypeScript reference for the shared directed/metric behavior family. */
export function behaviorForce(input: BehaviorForceInput): Vec3 {
	const { behavior, displacement, otherVelocity, velocity, normal, speed, force, radius } = input;
	if (behavior === 'ignore') return [0, 0, 0];
	const distance = magnitude(displacement),
		direction = gpuUnit(displacement);
	const orbit = gpuUnit(cross(normal, direction));
	const falloff = Math.max(0, Math.min(1, 1 - distance / Math.max(radius, 1e-6))) ** 2;
	const separationFalloff = (falloff * 2) / (distance / Math.max(radius, 1e-6) + 0.5);
	const key = input.pairKey ?? 0;
	let desired: Vec3 = [0, 0, 0];
	switch (behavior) {
		case 'flee':
			return scale(direction, -separationFalloff * force);
		case 'chase':
			desired = add(
				displacement,
				scale(otherVelocity, Math.min(0.5, radius / Math.max(speed, 1e-6)))
			);
			break;
		case 'cohere':
			return scale(
				add(
					limitedForce(displacement, force),
					limitedForce(subtract(scale(otherVelocity, 0.5), velocity), force * 0.5)
				),
				falloff
			);
		case 'align':
			return scale(
				limitedForce(subtract(limitedForce(otherVelocity, speed), velocity), force),
				falloff
			);
		case 'orbit':
			desired = orbit;
			break;
		case 'follow':
			desired = subtract(displacement, scale(gpuUnit(otherVelocity), radius * 0.35));
			break;
		case 'guard': {
			const error = distance - radius * 0.5;
			if (Math.abs(error) < Math.max(1e-5, radius * 1e-5)) return [0, 0, 0];
			return scale(
				limitedForce(
					subtract(
						scale(
							direction,
							Math.max(-1, Math.min(1, error / Math.max(radius * 0.5, 1e-6))) * speed
						),
						velocity
					),
					force
				),
				falloff
			);
		}
		case 'disperse':
			return scale(
				add(scale(direction, -1), scale(gpuRandomUnit(key), 0.3)),
				separationFalloff * force * 2
			);
		case 'mob':
			desired = add(scale(direction, 1.5), scale(orbit, (key & 1) === 0 ? 0.3 : -0.3));
			break;
		case 'mirror':
			return scale(
				limitedForce(subtract(limitedForce(scale(otherVelocity, -1), speed), velocity), force),
				falloff
			);
		case 'spiral':
			desired = add(scale(direction, 0.6), scale(orbit, 0.8 * (input.spiralHandedness ?? 1)));
			break;
	}
	if (magnitude(desired) < 1e-7) return [0, 0, 0];
	return scale(limitedForce(subtract(scale(gpuUnit(desired), speed), velocity), force), falloff);
}
/** Each resolved target owns its count. Flee/Scatter add across threats with inherited urgent caps. */
export function combineDirectedResponse(
	behavior: Behavior,
	sum: Vec3,
	count: number,
	force: number
): Vec3 {
	if (count <= 0) return [0, 0, 0];
	if (behavior === 'flee') return limitedForce(sum, force * 4);
	if (behavior === 'disperse') return limitedForce(sum, force * 5);
	const multiplier = {
		ignore: 1,
		chase: 2,
		cohere: 1.5,
		align: 1,
		orbit: 2,
		follow: 1.5,
		guard: 1.5,
		mob: 3.5,
		mirror: 1.5,
		spiral: 3
	}[behavior];
	return limitedForce(scale(sum, 1 / count), force * multiplier);
}
/** Interaction steering before the shared final acceleration cap; baseline flocking/contact/cursor forces are excluded. */
export function interactionAccelerationsAllPairs(
	scene: SceneDefinition,
	agents: readonly AgentState[],
	metrics?: readonly AgentMetrics[],
	query?: (index: number, radius: number) => NeighborRelation[]
): Vec3[] {
	if (scene.species.length > 16)
		throw new Error('The interaction reference supports at most 16 species.');
	return agents.map((agent, index) => {
		const sourceIndex = scene.species.findIndex((species) => species.key === agent.speciesKey);
		const source = scene.species[sourceIndex];
		if (!source) throw new Error(`Unknown agent species: ${agent.speciesKey}`);
		if (source.metricRules.length && (!metrics || metrics.length !== agents.length))
			throw new Error('Metric interactions require the complete immutable metric snapshot.');
		const normal =
			scene.world.kind === 'surface'
				? worldNormal(scene.world, agent.position, agent.triangle, agent.orientation)
				: normalize(scene.dynamics.orbitAxis);
		const radius = maximumNeighborRadius(scene, source.key);
		const neighbors = query
			? query(index, radius)
			: allPairsNeighbors(scene.world, agents, index, radius);
		const sums = scene.species.map((): Vec3 => [0, 0, 0]),
			counts = scene.species.map(() => 0);
		const metricSums = source.metricRules.map((): Vec3 => [0, 0, 0]),
			metricCounts = source.metricRules.map(() => 0);
		for (const neighbor of neighbors) {
			const other = agents[neighbor.index],
				targetIndex = scene.species.findIndex((species) => species.key === other.speciesKey);
			if (targetIndex < 0) throw new Error(`Unknown agent species: ${other.speciesKey}`);
			const pairKey = gpuHash(
				(Math.min(agent.id, other.id) ^
					Math.imul(Math.max(agent.id, other.id), 0x9e3779b9) ^
					scene.seed) >>>
					0
			);
			const base = {
				displacement: neighbor.displacement,
				otherVelocity: neighbor.velocity,
				velocity: agent.velocity,
				normal,
				speed: source.speed,
				force: source.force,
				pairKey,
				spiralHandedness: (sourceIndex + targetIndex) % 2 === 0 ? 1 : -1
			};
			const rule = resolveDirectedRule(scene, source.key, other.speciesKey);
			if (
				rule &&
				rule.behavior !== 'ignore' &&
				Math.abs(rule.strength) > 1e-7 &&
				neighbor.distance < (rule.radius ?? source.perception)
			) {
				sums[targetIndex] = add(
					sums[targetIndex],
					scale(
						behaviorForce({
							...base,
							behavior: rule.behavior,
							radius: rule.radius ?? source.perception
						}),
						rule.strength
					)
				);
				counts[targetIndex]++;
			}
			source.metricRules.forEach((rule, slot) => {
				if (
					rule.behavior === 'ignore' ||
					Math.abs(rule.strength) <= 1e-7 ||
					neighbor.distance >= (rule.radius ?? source.perception)
				)
					return;
				let value = metricValue(metrics![neighbor.index], rule.metric);
				if (rule.role === 'self') value = metricValue(metrics![index], rule.metric);
				if (rule.role === 'difference')
					value = metricDifference(rule.metric, value, metricValue(metrics![index], rule.metric));
				const mapped = evaluateCurve(
					rule.curve,
					Math.max(0, Math.min(1, (value - rule.range[0]) / (rule.range[1] - rule.range[0])))
				);
				if (mapped <= 1e-7) return;
				metricSums[slot] = add(
					metricSums[slot],
					scale(
						behaviorForce({
							...base,
							behavior: rule.behavior,
							radius: rule.radius ?? source.perception
						}),
						mapped * rule.strength
					)
				);
				metricCounts[slot]++;
			});
		}
		let acceleration: Vec3 = [0, 0, 0];
		for (let target = 0; target < scene.species.length; target++) {
			const rule = resolveDirectedRule(scene, source.key, scene.species[target].key);
			if (rule)
				acceleration = add(
					acceleration,
					combineDirectedResponse(rule.behavior, sums[target], counts[target], source.force)
				);
		}
		metricSums.forEach((sum, slot) => {
			if (metricCounts[slot]) acceleration = add(acceleration, scale(sum, 1 / metricCounts[slot]));
		});
		return acceleration;
	});
}
/** Removing a species also removes dangling directed references. */
export function removeSpecies(scene: SceneDefinition, key: string): SceneDefinition {
	if (scene.species.length <= 1) throw new Error('A scene needs at least one species.');
	return {
		...scene,
		species: scene.species.filter((species) => species.key !== key),
		speciesRules: scene.speciesRules.filter((rule) => rule.from !== key && rule.to !== key)
	};
}

/** GPU reference filter. Weight=1 leaves measurements raw; circular values follow the shortest arc. */
export function smoothMetrics(
	current: AgentMetrics,
	previous: AgentMetrics,
	weight = 1
): AgentMetrics {
	if (!Number.isFinite(weight) || weight < 0 || weight > 1)
		throw new Error('Smoothing weight must be 0–1.');
	const result = { ...current };
	for (const definition of METRICS) {
		if (definition.temporal === 'instant') continue;
		const field = METRIC_FIELDS[definition.id],
			a = previous[field],
			b = current[field];
		if (definition.circular) {
			let delta = b - a;
			if (delta > 0.5) delta -= 1;
			if (delta < -0.5) delta += 1;
			result[field] = (((a + delta * weight) % 1) + 1) % 1;
		} else result[field] = a + (b - a) * weight;
	}
	return result;
}
export function metricSmoothingWeight(dt: number, seconds: number): number {
	if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(seconds) || seconds < 0)
		throw new Error('Invalid smoothing timing.');
	return seconds === 0 ? 1 : -Math.expm1(-dt / seconds);
}
export function maximumNeighborRadius(
	scene: SceneDefinition,
	speciesKey: string,
	collisionSizeMultiplier = 1.2
): number {
	const species = scene.species.find((item) => item.key === speciesKey);
	if (!species || !Number.isFinite(collisionSizeMultiplier) || collisionSizeMultiplier < 0)
		throw new Error('Invalid query species or collision multiplier.');
	return interactionRadii(scene, collisionSizeMultiplier)[scene.species.indexOf(species)];
}
