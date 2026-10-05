import { describe, expect, it } from 'vitest';
import {
	allPairsNeighbors,
	assertScene,
	cloneScene,
	createNeighborGrid,
	CURATED_SCENES,
	decodeSceneShare,
	discoverScene,
	dot,
	encodeSceneShare,
	exportScene,
	globalInteractionRadius,
	importScene,
	initializePopulation,
	interactionRadii,
	localFrame,
	magnitude,
	maxSurfaceObstacleRadius,
	measureAllPairs,
	neighborhoodMeasure,
	projectWorldPoint,
	resizePopulation,
	seededRandom,
	surfaceObstacleMargin,
	torusApproximateRelation,
	torusChart,
	torusComponents,
	torusFrame,
	torusIntegrateMidpoint,
	torusLocalPoint,
	torusNormal,
	torusPoint,
	torusRotate,
	torusWorldVector,
	worldAdvance,
	worldBounds,
	worldBroadphaseRadius,
	worldDisplacement,
	worldDistance,
	worldExp,
	worldInteractionLimit,
	worldMeasure,
	worldNormal,
	worldTransport
} from '#lib/model';
import type { AgentState, SceneDefinition, Vec2, Vec3, WorldDefinition } from '#lib/model';

const world = { kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 } as const;
const scene = (): SceneDefinition =>
	cloneScene(CURATED_SCENES.find((scene) => scene.id === 'ring-currents')!);
const agent = (id: number, position: Vec3, velocity: Vec3): AgentState => ({
	id,
	birth: id,
	speciesKey: 'shoal',
	position,
	velocity
});
const closeVector = (actual: Vec3, expected: Vec3, tolerance = 1e-10) => {
	for (let axis = 0; axis < 3; axis++)
		expect(Math.abs(actual[axis] - expected[axis])).toBeLessThan(tolerance);
};
const angle = (a: Vec2, b: Vec2) =>
	Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));

describe('public torus geometry', () => {
	it('exposes the induced domain, canonical closest projection and continuous oriented frame', () => {
		expect(worldBounds(world)).toEqual([28, 8, 28]);
		expect(worldMeasure(world)).toBeCloseTo(4 * Math.PI ** 2 * 20 * 8, 10);
		expect(worldInteractionLimit(world)).toBe(2.4);
		expect(neighborhoodMeasure(world, 2)).toBeCloseTo(4 * Math.PI, 12);
		closeVector(projectWorldPoint(world, [0, 0, 0]), [12, 0, 0]);
		for (const theta of [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI - 1e-9, -Math.PI + 1e-9]) {
			const chart = { theta, phi: 1.1 },
				position = torusPoint(world, chart),
				[tube, azimuth] = torusFrame(chart);
			const [east, north] = localFrame(world, position);
			closeVector(east, azimuth.map((v) => -v) as unknown as Vec3);
			closeVector(north, tube);
			closeVector(worldNormal(world, position), torusNormal(chart));
			expect(dot(east, north)).toBeCloseTo(0, 12);
			closeVector(projectWorldPoint(world, position), position);
		}
	});
	it('roundtrips both seams and canonical signed-zero axis representatives', () => {
		for (const phi of [0, Math.PI]) {
			for (const theta of [0, Math.PI]) {
				const position = torusPoint(world, { theta, phi }),
					chart = torusChart(world, position);
				closeVector(torusPoint(world, chart), position);
			}
		}
		expect(torusChart(world, [-28, 0, -0])).toEqual({ theta: 0, phi: Math.PI });
		expect(torusChart(world, [12, -0, 0])).toEqual({ theta: Math.PI, phi: 0 });
	});
	it('uses symmetric midpoint distances and reversible chart-path neighbor vectors across seams', () => {
		const a = torusPoint(world, { theta: Math.PI - 0.02, phi: Math.PI - 0.01 }),
			b = torusPoint(world, { theta: -Math.PI + 0.04, phi: -Math.PI + 0.03 });
		const forward = worldDisplacement(world, a, b),
			reverse = worldDisplacement(world, b, a);
		expect(worldDistance(world, a, b)).toBeCloseTo(worldDistance(world, b, a), 12);
		closeVector(worldTransport(world, reverse, b, a), forward.map((v) => -v) as unknown as Vec3);
		expect(dot(forward, worldNormal(world, a))).toBeCloseTo(0, 12);
		expect(worldBroadphaseRadius(world, 2.2)).toBeCloseTo(2.2 * (1 + 2.2 / 24), 12);
		expect(() => allPairsNeighbors(world, [], 0, 2.4)).toThrow(/radius/);
	});
	it('inverts the approximate log for same-classifier contours without treating motion Exp as that inverse', () => {
		const random = seededRandom(924);
		for (let i = 0; i < 400; i++) {
			const from = {
				theta: random() * 2 * Math.PI - Math.PI,
				phi: random() * 2 * Math.PI - Math.PI
			};
			const length = 2.39 * random(),
				direction = random() * 2 * Math.PI;
			const displacement: Vec2 = [length * Math.cos(direction), length * Math.sin(direction)];
			const target = torusLocalPoint(world, from, displacement),
				relation = torusApproximateRelation(world, from, target);
			expect(
				Math.hypot(
					relation.displacement[0] - displacement[0],
					relation.displacement[1] - displacement[1]
				)
			).toBeLessThan(1e-11);
			expect(relation.distance).toBeCloseTo(length, 10);
		}
		const from = { theta: 2.7, phi: 3.1 },
			displacement: Vec2 = [0.8, 1.8];
		const position = torusPoint(world, from);
		const advanced = worldAdvance(world, position, torusWorldVector(from, displacement), 1);
		closeVector(worldExp(world, position, torusWorldVector(from, displacement)), advanced.position);
	});
	it('splits long motion internally while preserving physical speed and the actual prior transport path', () => {
		const chart = { theta: 2.7, phi: 3.1 },
			velocity: Vec2 = [2.4, 3.2],
			prior: Vec2 = [3, -1],
			duration = 12;
		const start = torusPoint(world, chart),
			integrated = torusIntegrateMidpoint(world, { ...chart, velocity }, duration);
		const advanced = worldAdvance(
			world,
			start,
			torusWorldVector(chart, velocity),
			duration,
			0,
			torusWorldVector(chart, prior)
		);
		closeVector(advanced.position, torusPoint(world, integrated));
		closeVector(advanced.velocity, torusWorldVector(integrated, integrated.velocity));
		closeVector(
			advanced.transportedPriorVelocity!,
			torusWorldVector(integrated, torusRotate(prior, integrated.transportAngle))
		);
		expect(magnitude(advanced.velocity)).toBeCloseTo(4, 11);
		expect(magnitude(advanced.transportedPriorVelocity!)).toBeCloseTo(Math.sqrt(10), 11);
		expect(dot(advanced.velocity, worldNormal(world, advanced.position))).toBeCloseTo(0, 11);
	});
	it('measures genuine steering rather than accumulated geometric turning along a different neighbor path', () => {
		const definition = resizePopulation(scene(), 1),
			chart = { theta: 1.8, phi: 3.1 },
			position = torusPoint(world, chart),
			velocity = torusWorldVector(chart, [2.4, 3.2]);
		const before = agent(1, position, velocity),
			free = worldAdvance(world, position, velocity, 12, 0, velocity);
		const map = new Map([[1, free.transportedPriorVelocity!]]);
		const [metric] = measureAllPairs(
			definition,
			[{ ...before, ...free }],
			[before],
			12,
			undefined,
			map
		);
		expect(metric.turnRate).toBeLessThan(1e-12);
		expect(metric.acceleration).toBeLessThan(1e-12);
		expect(() => measureAllPairs(definition, [{ ...before, ...free }], [before], 12)).toThrow(
			/actual motion path/
		);
		const steering: Vec2 = [1.5, -3.2],
			prior: Vec2 = [2.8, 1],
			old = agent(1, position, torusWorldVector(chart, prior));
		const after = worldAdvance(
			world,
			position,
			torusWorldVector(chart, steering),
			1.6,
			0,
			old.velocity
		);
		const [changed] = measureAllPairs(
			definition,
			[{ ...old, ...after }],
			[old],
			1.6,
			undefined,
			new Map([[1, after.transportedPriorVelocity!]])
		);
		expect(changed.turnRate).toBeCloseTo(angle(prior, steering) / 1.6, 11);
		expect(changed.acceleration).toBeCloseTo(
			Math.hypot(prior[0] - steering[0], prior[1] - steering[1]) / 1.6,
			11
		);
	});
});

describe('torus initialization and complete neighbor oracle', () => {
	it('samples exact induced area and isotropic tangent headings with deterministic stable IDs', () => {
		const definition = resizePopulation(scene(), 10000),
			population = initializePopulation(definition);
		let cosine = 0,
			sine = 0,
			cosineSquared = 0,
			azimuthCos = 0,
			azimuthSin = 0,
			headingA = 0,
			headingB = 0,
			headingSquared = 0;
		for (const a of population.agents) {
			const chart = torusChart(world, a.position),
				velocity = torusComponents(chart, a.velocity),
				speed = Math.hypot(...velocity);
			cosine += Math.cos(chart.theta);
			sine += Math.sin(chart.theta);
			cosineSquared += Math.cos(chart.theta) ** 2;
			azimuthCos += Math.cos(chart.phi);
			azimuthSin += Math.sin(chart.phi);
			headingA += velocity[0] / speed;
			headingB += velocity[1] / speed;
			headingSquared += (velocity[0] / speed) ** 2;
			expect(
				Math.hypot(Math.hypot(a.position[0], a.position[2]) - world.majorRadius, a.position[1])
			).toBeCloseTo(world.tubeRadius, 11);
			expect(dot(a.velocity, worldNormal(world, a.position))).toBeCloseTo(0, 11);
		}
		const count = population.agents.length;
		expect(Math.abs(cosine / count - world.tubeRadius / (2 * world.majorRadius))).toBeLessThan(
			0.025
		);
		for (const sum of [sine, azimuthCos, azimuthSin, headingA, headingB])
			expect(Math.abs(sum / count)).toBeLessThan(0.025);
		expect(Math.abs(cosineSquared / count - 0.5)).toBeLessThan(0.025);
		expect(Math.abs(headingSquared / count - 0.5)).toBeLessThan(0.025);
		expect(initializePopulation(resizePopulation(definition, 30))).toEqual(
			initializePopulation(resizePopulation(definition, 30))
		);
	});
	it('matches complete all-pairs queries and metrics with conservative embedded grid reach', () => {
		const definition = resizePopulation(scene(), 700),
			agents = initializePopulation(definition).agents,
			grid = createNeighborGrid(world, agents, 1.5);
		for (let index = 0; index < agents.length; index += 19)
			expect(grid.query(index, 2.2)).toEqual(
				allPairsNeighbors(world, agents, index, 2.2).sort((a, b) => a.id - b.id)
			);
		expect(
			measureAllPairs(definition, agents, undefined, undefined, (index, radius) =>
				grid.query(index, radius)
			)
		).toEqual(measureAllPairs(definition, agents));
	});
	it('retains all colocated neighbors and filters visually close but intrinsically distant surface points', () => {
		const position = torusPoint(world, { theta: 0, phi: 0 }),
			velocity = torusWorldVector({ theta: 0, phi: 0 }, [1, 0]);
		const agents = Array.from({ length: 180 }, (_, index) => agent(index + 1, position, velocity));
		expect(createNeighborGrid(world, agents, 1).query(0, 2.2)).toHaveLength(179);
		const opposite = torusPoint(world, { theta: Math.PI, phi: 0 });
		expect(worldDistance(world, position, opposite)).toBeGreaterThan(2.2);
		expect(
			allPairsNeighbors(world, [agent(1, position, velocity), agent(2, opposite, velocity)], 0, 2.2)
		).toHaveLength(0);
	});
});

describe('torus schema and effective range constraints', () => {
	it('roundtrips curated and discovered torus scenes through the new format and share encoding', () => {
		const curated = scene();
		expect(assertScene(curated)).toEqual(curated);
		expect(importScene(exportScene(curated))).toEqual(curated);
		expect(decodeSceneShare(encodeSceneShare(curated))).toEqual(curated);
		for (const seed of [0, 1, 73419, 0xffffffff]) {
			const discovered = discoverScene(seed, curated);
			expect(assertScene(discovered).world).toEqual(curated.world);
			expect(discovered).toEqual(discoverScene(seed, curated));
		}
	});
	it.each<WorldDefinition>([
		{ kind: 'surface', shape: 'torus', majorRadius: 2, tubeRadius: 0.99 },
		{ kind: 'surface', shape: 'torus', majorRadius: 15.9, tubeRadius: 8 },
		{ kind: 'surface', shape: 'torus', majorRadius: 80.1, tubeRadius: 8 },
		{ kind: 'surface', shape: 'torus', majorRadius: 10001, tubeRadius: 2000 }
	])('rejects a torus outside the public shape envelope: $majorRadius / $tubeRadius', (invalid) => {
		const definition = scene();
		definition.world = invalid;
		expect(() => assertScene(definition)).toThrow();
	});
	it('enforces the strict range on every declared interaction radius', () => {
		const perception = scene();
		perception.species[0].perception = 2.4;
		expect(() => assertScene(perception)).toThrow(/strictly below 0.3r/);
		const field = scene();
		field.forces.radius = 2.4;
		expect(() => assertScene(field)).toThrow(/strictly below 0.3r/);
		const rule = scene();
		rule.speciesRules[0].radius = 2.4;
		expect(() => assertScene(rule)).toThrow(/strictly below 0.3r/);
	});
	it('shares resolved query precedence with packing and retains soft contact reach independently of perception', () => {
		const definition = scene();
		definition.species.forEach((s) => (s.perception = 0.1));
		definition.speciesRules = [
			{ id: 'fallback', from: 'shoal', to: '*', behavior: 'chase', strength: 1, radius: 2.3 },
			{ id: 'ignore', from: 'shoal', to: 'amber', behavior: 'ignore', strength: 1, radius: null }
		];
		expect(interactionRadii(definition)).toEqual([0.336, 0.336]);
		expect(globalInteractionRadius(definition)).toBe(0.336);
		definition.dynamics.collision = 0;
		expect(interactionRadii(definition)).toEqual([0.28, 0.28]);
	});
	it('validates the full active obstacle force reach and gives the editor a strict usable clamp', () => {
		const definition = scene(),
			margin = surfaceObstacleMargin(definition),
			maximum = maxSurfaceObstacleRadius(definition);
		expect(margin).toBeCloseTo(0.7, 12);
		expect(maximum + margin).toBeLessThan(worldInteractionLimit(world));
		definition.obstacles = [
			{
				id: 'disk',
				shape: 'sphere',
				center: torusPoint(world, { theta: 1, phi: 2 }),
				radius: maximum
			}
		];
		expect(assertScene(definition)).toEqual(definition);
		const disk = definition.obstacles[0];
		if (disk.shape !== 'sphere') throw new Error('Expected intrinsic disk fixture.');
		disk.radius = 1.8;
		expect(() => assertScene(definition)).toThrow(/Active torus obstacle force reach/);
		definition.obstacleSettings.enabled = false;
		expect(assertScene(definition)).toEqual(definition);
		definition.obstacles[0].center = [0, 0, 0];
		expect(() => assertScene(definition)).toThrow(/lie on the torus/);
	});
	it('requires room for a positive legal obstacle radius even when obstacles are disabled', () => {
		const definition = scene();
		definition.world = { kind: 'surface', shape: 'torus', majorRadius: 2, tubeRadius: 1 };
		definition.species.forEach((s) => {
			s.size = 0.061;
			s.perception = 0.1;
		});
		definition.forces.radius = 0.2;
		definition.speciesRules = [];
		definition.obstacleSettings.enabled = false;
		expect(maxSurfaceObstacleRadius(definition)).toBe(0);
		expect(() => assertScene(definition)).toThrow(/positive legal obstacle radius/);
		definition.species.forEach((s) => (s.size = 0.04));
		expect(maxSurfaceObstacleRadius(definition)).toBeGreaterThan(0.001);
		expect(assertScene(definition)).toEqual(definition);
	});
});
