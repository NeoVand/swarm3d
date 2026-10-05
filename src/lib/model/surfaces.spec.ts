import { describe, expect, it } from 'vitest';
import {
	add,
	allPairsNeighbors,
	assertScene,
	createDefaultScene,
	createNeighborGrid,
	CURATED_SCENES,
	cylinderTransport,
	discoverScene,
	dot,
	initializePopulation,
	localFrame,
	magnitude,
	measureAllPairs,
	neighborhoodMeasure,
	projectWorldPoint,
	resizePopulation,
	scale,
	worldAdvance,
	worldBounds,
	worldDisplacement,
	worldDistance,
	worldExp,
	worldInteractionLimit,
	worldMeasure,
	worldNormal,
	worldTransport
} from '#lib/model';
import type { AgentState, Vec3, WorldDefinition } from '#lib/model';

const agent = (id: number, position: Vec3, velocity: Vec3 = [1, 0, 0]): AgentState => ({
	id,
	speciesKey: 'shoal',
	birth: id,
	position,
	velocity
});
const closeVector = (actual: Vec3, expected: Vec3, precision = 10) => {
	for (let axis = 0; axis < 3; axis++) expect(actual[axis]).toBeCloseTo(expected[axis], precision);
};
const cylinderPoint = (angle: number, y = 0, radius = 5): Vec3 => [
	radius * Math.cos(angle),
	y,
	radius * Math.sin(angle)
];
const azimuth = (angle: number): Vec3 => [-Math.sin(angle), 0, Math.cos(angle)];

describe('flat surface domains', () => {
	it('keeps plane geometry in XZ with exact metric, area and frame', () => {
		const world: WorldDefinition = {
			kind: 'surface',
			shape: 'plane',
			halfExtents: [2, 3],
			boundaries: 'reflect'
		};
		closeVector(worldBounds(world), [2, 0, 3]);
		closeVector(worldNormal(world, [1, 0, 1]), [0, 1, 0]);
		expect(localFrame(world, [1, 0, 1])).toEqual([
			[1, 0, 0],
			[0, 0, -1]
		]);
		expect(worldMeasure(world)).toBe(24);
		expect(neighborhoodMeasure(world, 2)).toBeCloseTo(4 * Math.PI, 12);
		expect(worldInteractionLimit(world)).toBe(Infinity);
		expect(worldDistance(world, [-2, 0, -3], [2, 0, 3])).toBeCloseTo(Math.hypot(4, 6), 12);
		closeVector(projectWorldPoint(world, [8, 12, -8]), [2, 0, -3]);
		closeVector(worldExp(world, [1, 0, 1], [5, 9, -5]), [2, 0, -3]);
	});
	it('preserves signed half-period ties and arbitrary wraps on a periodic plane', () => {
		const world: WorldDefinition = {
			kind: 'surface',
			shape: 'plane',
			halfExtents: [2, 3],
			boundaries: 'periodic'
		};
		closeVector(worldDisplacement(world, [0, 0, 0], [2, 0, 3]), [2, 0, 3]);
		closeVector(worldDisplacement(world, [2, 0, 3], [0, 0, 0]), [-2, 0, -3]);
		closeVector(worldDisplacement(world, [0, 0, 0], [10, 0, -15]), [2, 0, -3]);
		const advanced = worldAdvance(world, [1.9, 0, 2.9], [20, 0, 30], 2);
		closeVector(advanced.position, [1.9, 0, 2.9]);
		closeVector(advanced.velocity, [20, 0, 30]);
	});
	it('reflects repeated plane crossings, including exact endpoints and body insets', () => {
		const world: WorldDefinition = {
			kind: 'surface',
			shape: 'plane',
			halfExtents: [2, 3],
			boundaries: 'reflect'
		};
		const advanced = worldAdvance(world, [0, 0, 0], [13, 0, 7], 1);
		closeVector(advanced.position, [-1, 0, -1]);
		closeVector(advanced.velocity, [-13, 0, -7]);
		expect(magnitude(advanced.velocity)).toBeCloseTo(Math.hypot(13, 7), 12);
		closeVector(worldAdvance(world, [0, 0, 0], [-2, 0, 3], 1).velocity, [2, 0, -3]);
		closeVector(worldAdvance(world, [0, 0, 0], [4, 0, 0], 1, 0.25).position, [-0.5, 0, 0]);
	});
	it('uses cylinder arc length and preserves intrinsic components across the angular seam', () => {
		const world: WorldDefinition = { kind: 'surface', shape: 'cylinder', radius: 5, halfHeight: 4 };
		const a = Math.PI - 0.02,
			b = -Math.PI + 0.02;
		const from = cylinderPoint(a, 1),
			to = cylinderPoint(b, 4);
		const delta = worldDisplacement(world, from, to);
		expect(worldDistance(world, from, to)).toBeCloseTo(Math.hypot(0.2, 3), 12);
		expect(dot(delta, worldNormal(world, from))).toBeCloseTo(0, 12);
		closeVector(delta, add(scale(azimuth(a), 0.2), [0, 3, 0]));
		closeVector(worldExp(world, from, delta), to);
		closeVector(
			worldTransport(world, add(scale(azimuth(b), 2), [0, 1, 0]), to, from),
			add(scale(azimuth(a), 2), [0, 1, 0])
		);
		expect(worldMeasure(world)).toBeCloseTo(80 * Math.PI, 12);
		expect(worldInteractionLimit(world)).toBeCloseTo(5 * Math.PI, 12);
	});
	it('keeps cylinder half-circumference tie displacements antisymmetric after transport', () => {
		const world: WorldDefinition = { kind: 'surface', shape: 'cylinder', radius: 5, halfHeight: 4 };
		const from: Vec3 = [5, 0, 0],
			to: Vec3 = [-5, 0, 0];
		const forward = worldDisplacement(world, from, to),
			reverse = worldDisplacement(world, to, from);
		expect(dot(forward, [0, 0, 1])).toBeCloseTo(5 * Math.PI, 12);
		closeVector(add(forward, cylinderTransport(reverse, to, from)), [0, 0, 0]);
		expect(() => allPairsNeighbors(world, [agent(1, from), agent(2, to)], 0, 5 * Math.PI)).toThrow(
			/radius/
		);
	});
	it('canonicalizes signed-zero cylinder axes consistently with the shader', () => {
		const world: WorldDefinition = { kind: 'surface', shape: 'cylinder', radius: 5, halfHeight: 4 };
		const from: Vec3 = [5, 0, -0];
		for (const zero of [0, -0]) {
			const to: Vec3 = [-5, 0, zero];
			closeVector(worldDisplacement(world, from, to), [0, 0, 5 * Math.PI]);
			closeVector(worldDisplacement(world, to, from), [0, 0, 5 * Math.PI]);
			closeVector(worldExp(world, to, [0, 0, 0]), [-5, 0, 0]);
			closeVector(worldAdvance(world, to, [0, 0, 0], 0).position, [-5, 0, 0]);
		}
	});
	it('preserves speed and tangency through repeated angular wraps and axial reflections', () => {
		const world: WorldDefinition = { kind: 'surface', shape: 'cylinder', radius: 5, halfHeight: 2 };
		const velocity: Vec3 = [0, 9, 30 * Math.PI];
		const advanced = worldAdvance(world, [5, 0, 0], velocity, 2);
		closeVector(advanced.position, [5, 2, 0]);
		closeVector(advanced.velocity, [0, -9, 30 * Math.PI]);
		expect(dot(advanced.velocity, worldNormal(world, advanced.position))).toBeCloseTo(0, 9);
		expect(magnitude(advanced.velocity)).toBeCloseTo(magnitude(velocity), 10);
		closeVector(projectWorldPoint(world, [0, 10, 0]), [5, 2, 0]);
		closeVector(worldExp(world, [5, 0, 0], [0, 10, 0]), [5, 2, 0]);
	});
	it.each<WorldDefinition>([
		{ kind: 'surface', shape: 'plane', halfExtents: [20, 20], boundaries: 'periodic' },
		{ kind: 'surface', shape: 'cylinder', radius: 5, halfHeight: 100 }
	])('does not report geometric bending or wrapping as true steering on $shape', (world) => {
		const scene = resizePopulation(createDefaultScene(), 1);
		scene.world = world;
		const before = [agent(1, world.shape === 'cylinder' ? [5, 0, 0] : [0, 0, 19], [0, 0, 8])];
		const advanced = worldAdvance(world, before[0].position, before[0].velocity, 0.25);
		const [metrics] = measureAllPairs(scene, [{ ...before[0], ...advanced }], before, 0.25);
		expect(metrics.turnRate).toBeLessThan(1e-8);
		expect(metrics.acceleration).toBeLessThan(1e-8);
	});
});

describe('surface initialization and complete measurements', () => {
	it.each<WorldDefinition>([
		{ kind: 'surface', shape: 'plane', halfExtents: [2.3, 4.7], boundaries: 'reflect' },
		{ kind: 'surface', shape: 'plane', halfExtents: [2.3, 4.7], boundaries: 'periodic' },
		{ kind: 'surface', shape: 'cylinder', radius: 5, halfHeight: 3.1 }
	])('matches complete all-pairs neighbors and metrics on $shape / $boundaries', (world) => {
		const scene = resizePopulation(createDefaultScene(), 180);
		scene.world = world;
		const agents = initializePopulation(scene).agents;
		const grid = createNeighborGrid(world, agents, 0.6);
		for (let index = 0; index < agents.length; index += 13) {
			const expected = allPairsNeighbors(world, agents, index, 2.5).sort((a, b) => a.id - b.id);
			expect(grid.query(index, 2.5)).toEqual(expected);
		}
		expect(
			measureAllPairs(scene, agents, undefined, undefined, (index, radius) =>
				grid.query(index, radius)
			)
		).toEqual(measureAllPairs(scene, agents));
	});
	it('filters cylinder chord-close candidates by intrinsic distance', () => {
		const world: WorldDefinition = { kind: 'surface', shape: 'cylinder', radius: 5, halfHeight: 4 };
		const agents = [agent(1, cylinderPoint(0)), agent(2, cylinderPoint(2))];
		expect(worldDistance(world, agents[0].position, agents[1].position)).toBeCloseTo(10, 12);
		expect(createNeighborGrid(world, agents, 2).query(0, 8.5)).toHaveLength(0);
	});
	it('counts more than64 colocated plane agents once even across periodic cell repeats', () => {
		const world: WorldDefinition = {
			kind: 'surface',
			shape: 'plane',
			halfExtents: [2, 3],
			boundaries: 'periodic'
		};
		const agents = Array.from({ length: 180 }, (_, i) => agent(i + 1, [0, 0, 0]));
		const neighbors = createNeighborGrid(world, agents, 1).query(0, 10);
		expect(neighbors).toHaveLength(179);
		expect(new Set(neighbors.map((item) => item.id)).size).toBe(179);
	});
	it.each<WorldDefinition>([
		{ kind: 'surface', shape: 'plane', halfExtents: [18, 12], boundaries: 'reflect' },
		{ kind: 'surface', shape: 'plane', halfExtents: [18, 12], boundaries: 'periodic' },
		{ kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 14 }
	])('spawns uniformly in admissible physical area with tangent velocity on $shape', (world) => {
		const scene = resizePopulation(createDefaultScene(), 2400);
		scene.world = world;
		const agents = initializePopulation(scene).agents;
		const normalizedX: number[] = [],
			normalizedHeight: number[] = [];
		for (const a of agents) {
			const size = scene.species.find((species) => species.key === a.speciesKey)!.size;
			expect(dot(a.velocity, worldNormal(world, a.position))).toBeCloseTo(0, 10);
			if (world.kind === 'surface' && world.shape === 'cylinder') {
				expect(Math.hypot(a.position[0], a.position[2])).toBeCloseTo(world.radius, 11);
				normalizedX.push(a.position[0] / world.radius);
				normalizedHeight.push(a.position[1] / (world.halfHeight - size));
			} else if (world.kind === 'surface' && world.shape === 'plane') {
				const inset = world.boundaries === 'reflect' ? size : 0;
				expect(a.position[1]).toBe(0);
				normalizedX.push(a.position[0] / (world.halfExtents[0] - inset));
				normalizedHeight.push(a.position[2] / (world.halfExtents[1] - inset));
			}
		}
		const mean = (values: number[]) =>
			values.reduce((sum, value) => sum + value, 0) / values.length;
		expect(mean(normalizedX)).toBeCloseTo(0, 1);
		expect(mean(normalizedHeight)).toBeCloseTo(0, 1);
		expect(mean(normalizedHeight.map((value) => value ** 2))).toBeCloseTo(1 / 3, 1);
		expect(mean(normalizedX.map((value) => value ** 2))).toBeCloseTo(
			world.shape === 'cylinder' ? 1 / 2 : 1 / 3,
			1
		);
	});
	it('uses dimension-two density and moments on plane and cylinder', () => {
		for (const world of [
			{ kind: 'surface', shape: 'plane', halfExtents: [18, 12], boundaries: 'reflect' },
			{ kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 14 }
		] as WorldDefinition[]) {
			const scene = createDefaultScene();
			scene.world = world;
			scene.species[0].perception = 3;
			const position: Vec3 = world.shape === 'cylinder' ? [12, 0, 0] : [0, 0, 0];
			const frame = localFrame(world, position);
			const agents = [
				agent(1, position),
				...[frame[0], scale(frame[0], -1), frame[1], scale(frame[1], -1)].map((d, i) =>
					agent(i + 2, worldExp(world, position, d))
				)
			];
			const [metric] = measureAllPairs(scene, agents);
			expect(metric.density).toBeCloseTo(4 / (9 * Math.PI), 12);
			expect(metric.anisotropy).toBeCloseTo(0, 10);
		}
	});
});

describe('plane and cylinder scene format', () => {
	it('validates curated surfaces and preserves their domains during seeded discovery/share-ready parsing', () => {
		for (const scene of CURATED_SCENES.filter(
			(scene) => scene.world.shape === 'plane' || scene.world.shape === 'cylinder'
		)) {
			expect(assertScene(scene)).toEqual(scene);
			const discovered = discoverScene(73419, scene);
			expect(assertScene(discovered).world).toEqual(scene.world);
			expect(discovered).toEqual(discoverScene(73419, scene));
		}
	});
	it('rejects body radii that cannot fit bounded surface edges and cylinder cut-locus ranges', () => {
		const scene = createDefaultScene();
		scene.world = {
			kind: 'surface',
			shape: 'plane',
			halfExtents: [0.14, 18],
			boundaries: 'reflect'
		};
		expect(() => assertScene(scene)).toThrow(/plane half-extents/);
		scene.world = { kind: 'surface', shape: 'cylinder', radius: 4, halfHeight: 0.14 };
		expect(() => assertScene(scene)).toThrow(/cylinder half-height/);
		scene.world.halfHeight = 14;
		scene.species[0].perception = 4 * Math.PI;
		expect(() => assertScene(scene)).toThrow(/strictly below πR/);
	});
	it('requires obstacle centers to lie in their intrinsic surface and rejects ambient boxes', () => {
		const scene = createDefaultScene();
		scene.world = { kind: 'surface', shape: 'plane', halfExtents: [18, 12], boundaries: 'reflect' };
		scene.obstacles = [{ id: 'disk', shape: 'sphere', center: [1, 0, 2], radius: 1 }];
		expect(assertScene(scene).obstacles).toEqual(scene.obstacles);
		scene.obstacles[0].center = [1, 1, 2];
		expect(() => assertScene(scene)).toThrow(/bounded XZ plane/);
		scene.world = { kind: 'surface', shape: 'cylinder', radius: 4, halfHeight: 14 };
		scene.obstacles[0].center = [4, 2, 0];
		expect(assertScene(scene).obstacles).toEqual(scene.obstacles);
		scene.obstacles[0].center = [2, 2, 0];
		expect(() => assertScene(scene)).toThrow(/bounded cylinder/);
		scene.obstacles = [{ id: 'box', shape: 'box', center: [4, 2, 0], halfExtents: [1, 1, 1] }];
		expect(() => assertScene(scene)).toThrow(/intrinsic disk/);
	});
});
