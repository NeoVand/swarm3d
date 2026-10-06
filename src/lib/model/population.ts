import { isSmoothTopologyWorld, smoothTopologySurface } from './topology-smooth';
import type { AgentState, PopulationState, SceneDefinition, Vec3 } from '#lib/model/types';
import { cross, magnitude, normalize, scale } from '#lib/model/geometry';
import { keySeed, seededRandom } from '#lib/model/random';
import { torusPoint, torusSampleChart, torusWorldVector } from '#lib/model/torus';
import { isTopologyWorld, topologyMesh } from './topology-world';
import { sampleTopology } from './topology-mesh';

export const MAX_POPULATION = 100_000;
export function largestRemainder(total: number, weights: readonly number[]): number[] {
	if (
		!Number.isSafeInteger(total) ||
		total < 0 ||
		total > MAX_POPULATION ||
		!weights.length ||
		weights.some((value) => !Number.isFinite(value) || value < 0)
	)
		throw new Error('Invalid population allocation.');
	const maximum = Math.max(...weights);
	const normalized = weights.map((weight) => (maximum > 0 ? weight / maximum : 1));
	const sum = normalized.reduce((a, b) => a + b, 0);
	const shares = normalized.map((weight) => (total * weight) / sum);
	const result = shares.map(Math.floor);
	const remaining = total - result.reduce((a, b) => a + b, 0);
	const order = shares
		.map((share, index) => ({ index, remainder: share - result[index] }))
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (let i = 0; i < remaining; i++) result[order[i].index]++;
	return result;
}
export function resizePopulation(scene: SceneDefinition, total: number): SceneDefinition {
	const sorted = [...scene.species].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const counts = largestRemainder(
		total,
		sorted.map((species) => species.population)
	);
	const byKey = new Map(sorted.map((species, index) => [species.key, counts[index]]));
	return {
		...scene,
		species: scene.species.map((species) => ({ ...species, population: byKey.get(species.key)! }))
	};
}
function spawn(scene: SceneDefinition, speciesKey: string, id: number): AgentState {
	const species = scene.species.find((item) => item.key === speciesKey)!;
	const random = seededRandom(keySeed(scene.seed, `${speciesKey}:${id}`));
	const direction = (): Vec3 => {
		const y = 2 * random() - 1,
			angle = random() * 2 * Math.PI;
		return [Math.sqrt(1 - y * y) * Math.cos(angle), y, Math.sqrt(1 - y * y) * Math.sin(angle)];
	};
	let position: Vec3, velocity: Vec3;
	if (isTopologyWorld(scene.world)) {
		const mesh = topologyMesh(scene.world),
			sample = sampleTopology(mesh, random);
		const [a, b] = mesh.triangles[sample.triangle].map((i) => mesh.vertices[i]);
		const east = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]),
			north = cross(mesh.normals[sample.triangle], east);
		const angle = random() * Math.PI * 2,
			speed = species.speed * (0.65 + random() * 0.35);
		if (isSmoothTopologyWorld(scene.world)) {
			const corners = mesh.charts[sample.triangle];
			const chart = [0, 1].map((axis) =>
				corners.reduce((sum, p, i) => sum + p[axis] * sample.barycentric[i], 0)
			) as unknown as readonly [number, number];
			const surface = smoothTopologySurface(scene.world, chart),
				x = normalize(surface.u),
				y = cross(surface.normal, x);
			return {
				id,
				speciesKey,
				birth: id,
				position: surface.position,
				velocity: x.map(
					(v, i) => speed * (v * Math.cos(angle) + y[i] * Math.sin(angle))
				) as unknown as Vec3,
				triangle: sample.triangle,
				orientation: 1,
				chart
			};
		}
		velocity = east.map(
			(v, i) => speed * (v * Math.cos(angle) + north[i] * Math.sin(angle))
		) as unknown as Vec3;
		return {
			id,
			speciesKey,
			birth: id,
			position: sample.position,
			velocity,
			triangle: sample.triangle,
			orientation: 1
		};
	}
	if (scene.world.kind === 'volume') {
		const world = scene.world;
		if (world.shape === 'box')
			position = world.halfExtents.map(
				(half) =>
					(2 * random() - 1) *
					Math.max(1e-4, half - (world.boundaries === 'periodic' ? 0 : species.size))
			) as unknown as Vec3;
		else if (world.shape === 'sphere')
			position = scale(
				direction(),
				Math.cbrt(random()) * Math.max(1e-4, world.radius - species.size)
			);
		else if (world.shape === 'cylinder') {
			const angle = random() * Math.PI * 2,
				radius = Math.sqrt(random()) * Math.max(1e-4, world.radius - species.size);
			position = [
				radius * Math.cos(angle),
				(2 * random() - 1) * Math.max(1e-4, world.halfHeight - species.size),
				radius * Math.sin(angle)
			];
		} else {
			// Toroidal volume Jacobian is rho*(R+rho*cos(theta)); accept/reject
			// the physical cross-section area so the inner tube is not oversampled.
			const maximum = Math.max(1e-4, world.tubeRadius - species.size);
			let radius: number, theta: number;
			do {
				radius = Math.sqrt(random()) * maximum;
				theta = random() * Math.PI * 2;
			} while (
				random() * (world.majorRadius + maximum) >
				world.majorRadius + radius * Math.cos(theta)
			);
			const phi = random() * Math.PI * 2,
				radial = world.majorRadius + radius * Math.cos(theta);
			position = [radial * Math.cos(phi), radius * Math.sin(theta), radial * Math.sin(phi)];
		}
		velocity = scale(direction(), species.speed * (0.65 + random() * 0.35));
	} else if (scene.world.shape === 'plane') {
		const inset = scene.world.boundaries === 'reflect' ? species.size : 0;
		position = [
			(2 * random() - 1) * (scene.world.halfExtents[0] - inset),
			0,
			(2 * random() - 1) * (scene.world.halfExtents[1] - inset)
		];
		const angle = random() * Math.PI * 2;
		velocity = scale(
			[Math.cos(angle), 0, Math.sin(angle)],
			species.speed * (0.65 + random() * 0.35)
		);
	} else if (scene.world.shape === 'cylinder') {
		const theta = random() * Math.PI * 2;
		position = [
			scene.world.radius * Math.cos(theta),
			(2 * random() - 1) * (scene.world.halfHeight - species.size),
			scene.world.radius * Math.sin(theta)
		];
		const angle = random() * Math.PI * 2;
		velocity = scale(
			[-Math.sin(theta) * Math.cos(angle), Math.sin(angle), Math.cos(theta) * Math.cos(angle)],
			species.speed * (0.65 + random() * 0.35)
		);
	} else if (scene.world.shape === 'torus') {
		const chart = torusSampleChart(scene.world, random),
			angle = random() * Math.PI * 2,
			speed = species.speed * (0.65 + random() * 0.35);
		position = torusPoint(scene.world, chart);
		// One speed draw and an isotropic angle in the physical orthonormal frame.
		velocity = torusWorldVector(chart, [Math.cos(angle) * speed, Math.sin(angle) * speed]);
	} else {
		const normal = direction();
		position = scale(normal, scene.world.radius);
		let east = cross(normal, [0, 1, 0]);
		if (magnitude(east) < 1e-8) east = cross(normal, [1, 0, 0]);
		east = normalize(east);
		const north = cross(normal, east),
			angle = random() * Math.PI * 2;
		velocity = scale(
			[
				east[0] * Math.cos(angle) + north[0] * Math.sin(angle),
				east[1] * Math.cos(angle) + north[1] * Math.sin(angle),
				east[2] * Math.cos(angle) + north[2] * Math.sin(angle)
			],
			species.speed * (0.65 + random() * 0.35)
		);
	}
	return { id, speciesKey, birth: id, position, velocity };
}
export function initializePopulation(scene: SceneDefinition, generation = 1): PopulationState {
	return reconcilePopulation({ agents: [], nextId: 1, generation }, scene);
}
export const createPopulation = initializePopulation;
/** Preserve surviving IDs and their entire state; ID/birth ordering chooses removals deterministically. */
export function reconcilePopulation(
	previous: PopulationState,
	scene: SceneDefinition
): PopulationState {
	const agents: AgentState[] = [];
	let nextId = previous.nextId;
	if (!Number.isSafeInteger(nextId) || nextId < 1) throw new Error('Invalid next agent ID.');
	if (nextId > 0xffffffff)
		throw new Error('Agent ID capacity exhausted; start a new run generation.');
	const ids = new Set<number>();
	for (const agent of previous.agents) {
		if (!Number.isSafeInteger(agent.id) || agent.id < 1 || ids.has(agent.id) || agent.id >= nextId)
			throw new Error('Population contains invalid or duplicate IDs.');
		ids.add(agent.id);
	}
	for (const species of [...scene.species].sort((a, b) =>
		a.key < b.key ? -1 : a.key > b.key ? 1 : 0
	)) {
		const survivors = previous.agents
			.filter((agent) => agent.speciesKey === species.key)
			.sort((a, b) => a.birth - b.birth || a.id - b.id)
			.slice(0, species.population);
		agents.push(
			...survivors.map((agent) => ({
				...agent,
				position: [...agent.position] as unknown as Vec3,
				velocity: [...agent.velocity] as unknown as Vec3
			}))
		);
		for (let i = survivors.length; i < species.population; i++) {
			if (nextId >= 0xffffffff)
				throw new Error('Agent ID capacity exhausted; start a new run generation.');
			agents.push(spawn(scene, species.key, nextId++));
		}
	}
	return { agents, nextId, generation: previous.generation };
}
