import type { AgentState, NeighborRelation, Vec3, WorldDefinition } from '#lib/model/types';
import {
	torusAdvanceWorld,
	torusApproximateRelation,
	torusArea,
	torusBroadphaseRadius,
	torusChart,
	torusChartTransportAngle,
	torusComponents,
	torusFrame,
	torusLocalRange,
	torusNormal,
	torusPoint,
	torusRotate,
	torusWorldVector
} from '#lib/model/torus';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, amount: number): Vec3 => [
	a[0] * amount,
	a[1] * amount,
	a[2] * amount
];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];
export const magnitude = (a: Vec3): number => Math.hypot(...a);
export function normalize(a: Vec3): Vec3 {
	const norm = magnitude(a);
	return norm > 1e-12 ? scale(a, 1 / norm) : [0, 0, 0];
}
export function tangentProjection(vector: Vec3, position: Vec3): Vec3 {
	const normal = normalize(position);
	return subtract(vector, scale(normal, dot(vector, normal)));
}
const clampDot = (value: number) => Math.max(-1, Math.min(1, value));

/** Shortest signed representative; exact half-period ties retain the original sign. */
export function minimumImage(displacement: number, half: number): number {
	const span = half * 2;
	if (displacement > half) return displacement - Math.ceil((displacement - half) / span) * span;
	if (displacement < -half) return displacement + Math.ceil((-half - displacement) / span) * span;
	return displacement;
}
const wrapCoordinate = (value: number, half: number) =>
	((((value + half) % (2 * half)) + 2 * half) % (2 * half)) - half;

export function worldNormal(world: WorldDefinition, position: Vec3): Vec3 {
	if (world.kind === 'surface' && world.shape === 'torus')
		return torusNormal(torusChart(world, position));
	if (world.kind === 'surface' && world.shape === 'sphere') return normalize(position);
	if (world.kind === 'surface' && world.shape === 'cylinder') {
		const length = Math.hypot(position[0], position[2]);
		return length > 1e-12 ? [position[0] / length, 0, position[2] / length] : [1, 0, 0];
	}
	return [0, 1, 0];
}
export function worldTangent(world: WorldDefinition, vector: Vec3, position: Vec3): Vec3 {
	if (world.kind === 'volume') return vector;
	const normal = worldNormal(world, position);
	return subtract(vector, scale(normal, dot(vector, normal)));
}
export function worldBounds(world: WorldDefinition): Vec3 {
	if (world.kind === 'volume') return world.halfExtents;
	if (world.shape === 'plane') return [world.halfExtents[0], 0, world.halfExtents[1]];
	if (world.shape === 'torus')
		return [
			world.majorRadius + world.tubeRadius,
			world.tubeRadius,
			world.majorRadius + world.tubeRadius
		];
	return [world.radius, world.shape === 'cylinder' ? world.halfHeight : world.radius, world.radius];
}
export function worldMeasure(world: WorldDefinition): number {
	if (world.kind === 'volume')
		return 8 * world.halfExtents[0] * world.halfExtents[1] * world.halfExtents[2];
	if (world.shape === 'plane') return 4 * world.halfExtents[0] * world.halfExtents[1];
	if (world.shape === 'torus') return torusArea(world);
	if (world.shape === 'cylinder') return 4 * Math.PI * world.radius * world.halfHeight;
	return 4 * Math.PI * world.radius ** 2;
}
/** Strict radius envelope for a unique local interaction direction. */
export function worldInteractionLimit(world: WorldDefinition): number {
	if (world.kind === 'volume' || world.shape === 'plane') return Infinity;
	if (world.shape === 'torus') return torusLocalRange(world);
	return Math.PI * world.radius * (world.shape === 'sphere' ? 0.5 : 1);
}
export function neighborhoodMeasure(world: WorldDefinition, radius: number): number {
	if (world.kind === 'volume') return (4 * Math.PI * radius ** 3) / 3;
	if (world.shape === 'sphere')
		return 2 * Math.PI * world.radius ** 2 * (1 - Math.cos(radius / world.radius));
	return Math.PI * radius ** 2;
}
/** Canonical point for picking/stamping; bounded edges clamp rather than reflect. */
export function projectWorldPoint(world: WorldDefinition, point: Vec3): Vec3 {
	if (world.kind === 'surface' && world.shape === 'torus')
		return torusPoint(world, torusChart(world, point));
	if (world.kind === 'surface' && world.shape === 'sphere') {
		return magnitude(point) > 1e-12 ? scale(normalize(point), world.radius) : [0, world.radius, 0];
	}
	if (world.kind === 'surface' && world.shape === 'cylinder') {
		const normal = worldNormal(world, point);
		return [
			normal[0] * world.radius,
			Math.max(-world.halfHeight, Math.min(world.halfHeight, point[1])),
			normal[2] * world.radius
		];
	}
	const half = worldBounds(world);
	const periodic = world.boundaries === 'periodic';
	return point.map((value, axis) =>
		half[axis] === 0
			? 0
			: periodic
				? wrapCoordinate(value, half[axis])
				: Math.max(-half[axis], Math.min(half[axis], value))
	) as unknown as Vec3;
}
function cylinderTangent(position: Vec3): Vec3 {
	const norm = Math.hypot(position[0], position[2]);
	return norm > 1e-12 ? [-position[2] / norm, 0, position[0] / norm] : [0, 0, 1];
}
/** Match the shader's axis representative: the negative X axis is always +π. */
function cylinderAngle(position: Vec3): number {
	return position[2] === 0 ? (position[0] < 0 ? Math.PI : 0) : Math.atan2(position[2], position[0]);
}
export function cylinderLog(from: Vec3, to: Vec3, radius: number): Vec3 {
	const angle = minimumImage(cylinderAngle(to) - cylinderAngle(from), Math.PI);
	return add(scale(cylinderTangent(from), radius * angle), [0, to[1] - from[1], 0]);
}
export function cylinderTransport(vector: Vec3, from: Vec3, to: Vec3): Vec3 {
	return add(scale(cylinderTangent(to), dot(vector, cylinderTangent(from))), [0, vector[1], 0]);
}
/** Tangent exponential displacement for UI geometry; bounded edges clamp, periodic edges wrap. */
export function worldExp(world: WorldDefinition, position: Vec3, displacement: Vec3): Vec3 {
	if (world.kind === 'surface' && world.shape === 'torus')
		return torusAdvanceWorld(world, position, displacement, 1).position;
	if (world.kind === 'surface' && world.shape === 'sphere')
		return sphereExp(position, displacement, world.radius);
	if (world.kind === 'surface' && world.shape === 'cylinder') {
		const angle =
			cylinderAngle(position) + dot(displacement, cylinderTangent(position)) / world.radius;
		return projectWorldPoint(world, [
			world.radius * Math.cos(angle),
			position[1] + displacement[1],
			world.radius * Math.sin(angle)
		]);
	}
	return projectWorldPoint(world, add(position, worldTangent(world, displacement, position)));
}
export function worldTransport(world: WorldDefinition, vector: Vec3, from: Vec3, to: Vec3): Vec3 {
	if (world.kind === 'surface' && world.shape === 'torus') {
		const source = torusChart(world, from),
			target = torusChart(world, to);
		return torusWorldVector(
			target,
			torusRotate(torusComponents(source, vector), torusChartTransportAngle(source, target))
		);
	}
	if (world.kind === 'surface' && world.shape === 'sphere')
		return sphereTransport(vector, from, to);
	if (world.kind === 'surface' && world.shape === 'cylinder')
		return cylinderTransport(vector, from, to);
	return worldTangent(world, vector, to);
}
function reflectCoordinate(
	value: number,
	velocity: number,
	half: number
): readonly [number, number] {
	const unit = (value + half) / (2 * half),
		segment = Math.floor(unit),
		fraction = unit - segment;
	const mirrored = Math.abs(segment % 2) === 1;
	const position = mirrored ? half - fraction * 2 * half : -half + fraction * 2 * half;
	let reflectedVelocity = mirrored ? -velocity : velocity;
	if (position === half) reflectedVelocity = -Math.abs(velocity);
	if (position === -half) reflectedVelocity = Math.abs(velocity);
	return [position, reflectedVelocity];
}
/** Exact free domain motion with optional physical body-radius boundary inset. */
export function worldAdvance(
	world: WorldDefinition,
	position: Vec3,
	velocity: Vec3,
	dt: number,
	inset = 0,
	priorVelocity?: Vec3
): { position: Vec3; velocity: Vec3; transportedPriorVelocity?: Vec3 } {
	if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(inset) || inset < 0)
		throw new Error('Invalid domain advancement.');
	if (world.kind === 'surface' && world.shape === 'torus')
		return torusAdvanceWorld(world, position, velocity, dt, priorVelocity);
	if (world.kind === 'surface' && world.shape === 'sphere') {
		const result = sphereAdvance(position, velocity, dt, world.radius);
		if (!priorVelocity) return result;
		const tangent = tangentProjection(velocity, position),
			speed = magnitude(tangent);
		if (speed < 1e-12)
			return { ...result, transportedPriorVelocity: tangentProjection(priorVelocity, position) };
		const axis = normalize(cross(normalize(position), tangent)),
			angle = (speed * dt) / world.radius;
		const prior = tangentProjection(priorVelocity, position);
		return {
			...result,
			transportedPriorVelocity: add(
				add(scale(prior, Math.cos(angle)), scale(cross(axis, prior), Math.sin(angle))),
				scale(axis, dot(axis, prior) * (1 - Math.cos(angle)))
			)
		};
	}
	if (world.kind === 'surface' && world.shape === 'cylinder') {
		const azimuthVelocity = dot(velocity, cylinderTangent(position));
		const angle = cylinderAngle(position) + (azimuthVelocity * dt) / world.radius;
		const [height, heightVelocity] = reflectCoordinate(
			position[1] + velocity[1] * dt,
			velocity[1],
			Math.max(1e-4, world.halfHeight - inset)
		);
		const next: Vec3 = [world.radius * Math.cos(angle), height, world.radius * Math.sin(angle)];
		return {
			position: next,
			velocity: add(scale(cylinderTangent(next), azimuthVelocity), [0, heightVelocity, 0]),
			...(priorVelocity
				? { transportedPriorVelocity: cylinderTransport(priorVelocity, position, next) }
				: {})
		};
	}
	const half = worldBounds(world),
		tangent = worldTangent(world, velocity, position);
	const next = [...add(position, scale(tangent, dt))] as [number, number, number];
	const nextVelocity = [...tangent] as [number, number, number];
	for (let axis = 0; axis < 3; axis++) {
		if (half[axis] === 0) {
			next[axis] = 0;
			nextVelocity[axis] = 0;
		} else if (world.boundaries === 'periodic') next[axis] = wrapCoordinate(next[axis], half[axis]);
		else
			[next[axis], nextVelocity[axis]] = reflectCoordinate(
				next[axis],
				nextVelocity[axis],
				Math.max(1e-4, half[axis] - inset)
			);
	}
	return {
		position: next,
		velocity: nextVelocity,
		...(priorVelocity ? { transportedPriorVelocity: worldTangent(world, priorVelocity, next) } : {})
	};
}

export function sphereDistance(from: Vec3, to: Vec3, radius: number): number {
	const p = normalize(from),
		q = normalize(to);
	return radius * Math.atan2(magnitude(cross(p, q)), clampDot(dot(p, q)));
}
export function sphereLog(from: Vec3, to: Vec3, radius: number): Vec3 {
	const p = normalize(from),
		q = normalize(to);
	const cosine = clampDot(dot(p, q));
	const tangent = subtract(q, scale(p, cosine));
	const sine = magnitude(tangent);
	if (sine < 1e-12) {
		if (cosine < 0) throw new Error('Antipodal sphere points have no unique logarithm.');
		return [0, 0, 0];
	}
	return scale(tangent, (radius * Math.atan2(sine, cosine)) / sine);
}
export function sphereExp(position: Vec3, displacement: Vec3, radius: number): Vec3 {
	const normal = normalize(position);
	const tangent = tangentProjection(displacement, position);
	const length = magnitude(tangent);
	if (length < 1e-12) return scale(normal, radius);
	return scale(
		normalize(
			add(
				scale(normal, Math.cos(length / radius)),
				scale(tangent, Math.sin(length / radius) / length)
			)
		),
		radius
	);
}
export function sphereTransport(vector: Vec3, from: Vec3, to: Vec3): Vec3 {
	const p = normalize(from),
		q = normalize(to);
	const denominator = 1 + clampDot(dot(p, q));
	if (denominator < 1e-12)
		throw new Error('Transport between antipodal points requires a chosen path.');
	const tangent = tangentProjection(vector, from);
	return subtract(tangent, scale(add(p, q), dot(tangent, q) / denominator));
}
export function sphereAdvance(
	position: Vec3,
	velocity: Vec3,
	dt: number,
	radius: number
): { position: Vec3; velocity: Vec3 } {
	const tangent = tangentProjection(velocity, position);
	const speed = magnitude(tangent);
	const angle = (speed * dt) / radius;
	const next = sphereExp(position, scale(tangent, dt), radius);
	// This step has a chosen arc, so it remains defined even at an antipodal endpoint.
	return {
		position: next,
		velocity: add(
			scale(tangent, Math.cos(angle)),
			scale(normalize(position), -speed * Math.sin(angle))
		)
	};
}
export function localFrame(world: WorldDefinition, position: Vec3): readonly [Vec3, Vec3] {
	if (world.kind === 'surface' && world.shape === 'torus') {
		const [theta, phi] = torusFrame(torusChart(world, position));
		return [scale(phi, -1), theta];
	}
	if (world.kind === 'volume' || world.shape === 'plane')
		return [
			[1, 0, 0],
			[0, 0, -1]
		];
	const normal = worldNormal(world, position);
	let east = cross([0, 1, 0], normal);
	if (magnitude(east) < 1e-6) east = cross([1, 0, 0], normal);
	east = normalize(east);
	return [east, normalize(cross(normal, east))];
}
export function bearing(vector: Vec3, frame: readonly [Vec3, Vec3]): number {
	const x = dot(vector, frame[0]),
		y = dot(vector, frame[1]);
	if (Math.hypot(x, y) < 1e-12) return 0;
	return (((Math.atan2(y, x) / (2 * Math.PI)) % 1) + 1) % 1;
}
export function worldDisplacement(world: WorldDefinition, from: Vec3, to: Vec3): Vec3 {
	if (world.kind === 'surface' && world.shape === 'torus') {
		const origin = torusChart(world, from);
		return torusWorldVector(
			origin,
			torusApproximateRelation(world, origin, torusChart(world, to)).displacement
		);
	}
	if (world.kind === 'surface' && world.shape === 'sphere')
		return sphereLog(from, to, world.radius);
	if (world.kind === 'surface' && world.shape === 'cylinder')
		return cylinderLog(from, to, world.radius);
	const delta = [...subtract(to, from)] as [number, number, number];
	const half = worldBounds(world);
	if (world.kind === 'surface') delta[1] = 0;
	if (world.boundaries === 'periodic')
		for (let axis = 0; axis < 3; axis++) {
			if (half[axis] > 0) delta[axis] = minimumImage(delta[axis], half[axis]);
		}
	return delta;
}
export function worldDistance(world: WorldDefinition, from: Vec3, to: Vec3): number {
	if (world.kind === 'surface' && world.shape === 'torus')
		return torusApproximateRelation(world, torusChart(world, from), torusChart(world, to)).distance;
	return world.kind === 'surface' && world.shape === 'sphere'
		? sphereDistance(from, to, world.radius)
		: magnitude(worldDisplacement(world, from, to));
}
/** Conservative embedded reach; the final query always uses the domain's own metric. */
export function worldBroadphaseRadius(world: WorldDefinition, radius: number): number {
	if (world.kind === 'surface' && world.shape === 'sphere')
		return 2 * world.radius * Math.sin(radius / (2 * world.radius));
	if (world.kind === 'surface' && world.shape === 'torus')
		return torusBroadphaseRadius(world, radius);
	return radius;
}
export function neighborRelation(
	world: WorldDefinition,
	agents: readonly AgentState[],
	selfIndex: number,
	otherIndex: number,
	radius: number
): NeighborRelation | undefined {
	const self = agents[selfIndex],
		other = agents[otherIndex];
	if (self.id === other.id) return undefined;
	const distance = worldDistance(world, self.position, other.position);
	if (distance > radius) return undefined;
	return {
		id: other.id,
		index: otherIndex,
		distance,
		displacement: worldDisplacement(world, self.position, other.position),
		velocity: worldTransport(world, other.velocity, other.position, self.position)
	};
}
export function allPairsNeighbors(
	world: WorldDefinition,
	agents: readonly AgentState[],
	selfIndex: number,
	radius: number
): NeighborRelation[] {
	if (!Number.isFinite(radius) || radius <= 0 || radius >= worldInteractionLimit(world))
		throw new Error('Unsupported neighbor radius.');
	const neighbors: NeighborRelation[] = [];
	for (let index = 0; index < agents.length; index++) {
		const relation = neighborRelation(world, agents, selfIndex, index, radius);
		if (relation) neighbors.push(relation);
	}
	return neighbors;
}

export interface NeighborGrid {
	query(selfIndex: number, radius: number): NeighborRelation[];
	cellCount: number;
}
/** Complete reference grid: every candidate is tested, with no cell or neighbor capacity. */
export function createNeighborGrid(
	world: WorldDefinition,
	agents: readonly AgentState[],
	cellSize: number
): NeighborGrid {
	if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Cell size must be positive.');
	const periodic =
		world.kind === 'volume'
			? [0, 1, 2].map(() => world.boundaries === 'periodic')
			: world.shape === 'plane'
				? [world.boundaries === 'periodic', false, world.boundaries === 'periodic']
				: [false, false, false];
	const half = worldBounds(world);
	const dimensions = half.map((value) => Math.max(1, Math.ceil((2 * value) / cellSize)));
	const widths = half.map((value, axis) =>
		periodic[axis] ? (2 * value) / dimensions[axis] : cellSize
	);
	const key = (coordinates: readonly number[]) =>
		coordinates
			.map((value, axis) =>
				periodic[axis] ? ((value % dimensions[axis]) + dimensions[axis]) % dimensions[axis] : value
			)
			.join(',');
	const coordinates = (position: Vec3) =>
		position.map((value, axis) => Math.floor((value + half[axis]) / widths[axis]));
	const cells = new Map<string, number[]>();
	agents.forEach((agent, index) => {
		const id = key(coordinates(agent.position));
		const list = cells.get(id) ?? [];
		list.push(index);
		cells.set(id, list);
	});
	return {
		cellCount: cells.size,
		query(selfIndex, radius) {
			if (!Number.isFinite(radius) || radius <= 0 || radius >= worldInteractionLimit(world))
				throw new Error('Unsupported neighbor radius.');
			const searchRadius = worldBroadphaseRadius(world, radius);
			const center = coordinates(agents[selfIndex].position);
			const reach = widths.map((width, axis) =>
				half[axis] === 0 ? 0 : Math.ceil(searchRadius / width)
			);
			// Large-radius oracle queries can test all agents more cheaply than empty cells.
			if (
				reach.reduce((product, value) => product * (2 * value + 1), 1) >
				Math.max(64, cells.size * 4)
			)
				return allPairsNeighbors(world, agents, selfIndex, radius).sort((a, b) => a.id - b.id);
			const visited = new Set<string>();
			const result: NeighborRelation[] = [];
			for (let x = center[0] - reach[0]; x <= center[0] + reach[0]; x++)
				for (let y = center[1] - reach[1]; y <= center[1] + reach[1]; y++)
					for (let z = center[2] - reach[2]; z <= center[2] + reach[2]; z++) {
						const id = key([x, y, z]);
						if (visited.has(id)) continue;
						visited.add(id);
						for (const index of cells.get(id) ?? []) {
							const relation = neighborRelation(world, agents, selfIndex, index, radius);
							if (relation) result.push(relation);
						}
					}
			return result.sort((a, b) => a.id - b.id);
		}
	};
}
