import { describe, expect, it } from 'vitest';
import { createDefaultScene, createSpecies } from '#lib/model/defaults';
import { curvePreset } from '#lib/model/curves';
import {
	createNeighborGrid,
	dot,
	magnitude,
	scale,
	worldExp,
	worldNormal
} from '#lib/model/geometry';
import {
	behaviorForce,
	combineDirectedResponse,
	interactionAccelerationsAllPairs,
	measureAllPairs,
	smoothMetrics
} from '#lib/model/oracles';
import type { BehaviorForceInput } from '#lib/model/oracles';
import type { AgentState, SceneDefinition, Vec3, WorldDefinition } from '#lib/model/types';

function sceneFor(world?: WorldDefinition): SceneDefinition {
	const scene = createDefaultScene();
	scene.species = [createSpecies('observer'), createSpecies('leader'), createSpecies('other')];
	for (const species of scene.species) {
		species.speed = 4;
		species.force = 2;
		species.perception = 4;
	}
	scene.speciesRules = [];
	if (world) scene.world = world;
	if (world?.shape === 'torus') for (const species of scene.species) species.perception = 2.2;
	return scene;
}
const agent = (id: number, speciesKey: string, position: Vec3, velocity: Vec3): AgentState => ({
	id,
	speciesKey,
	position,
	velocity,
	birth: id
});
const input = (patch: Partial<BehaviorForceInput> = {}): BehaviorForceInput => ({
	behavior: 'align',
	displacement: [1, 0, 0],
	otherVelocity: [1, 0, 0],
	velocity: [1, 0, 0],
	normal: [0, 1, 0],
	speed: 4,
	force: 2,
	radius: 4,
	...patch
});

describe('directed interaction reference semantics', () => {
	it('does not accelerate equal velocities below the observer speed cap', () => {
		expect(behaviorForce(input())).toEqual([0, 0, 0]);
	});
	it('brakes to a stationary target instead of dropping its zero heading', () => {
		const braking = behaviorForce(input({ otherVelocity: [0, 0, 0] }));
		expect(braking[0]).toBeCloseTo(-0.5625, 12);
		expect(braking.slice(1)).toEqual([0, 0]);
	});
	it('matches actual slower target speed and bounds faster targets by the observer cap', () => {
		expect(behaviorForce(input({ otherVelocity: [0.4, 0, 0] }))[0]).toBeCloseTo(-0.3375, 12);
		expect(behaviorForce(input({ otherVelocity: [20, 0, 0], force: 20 }))[0]).toBeCloseTo(
			1.6875,
			12
		);
	});
	it('mirrors actual opposing velocity magnitude, including stationary braking', () => {
		expect(magnitude(behaviorForce(input({ behavior: 'mirror', velocity: [-1, 0, 0] })))).toBe(0);
		expect(behaviorForce(input({ behavior: 'mirror', otherVelocity: [0, 0, 0] }))[0]).toBeCloseTo(
			-0.5625,
			12
		);
	});
	it('retains Cohere attraction separately from partial target velocity influence', () => {
		const force = behaviorForce(
			input({ behavior: 'cohere', otherVelocity: [0, 0, 2], velocity: [0, 0, 0] })
		);
		expect(force).toEqual([0.5625, 0, 0.5625]);
	});
	it('uses one Spiral handedness across all agent pairs in a species relationship', () => {
		for (const pairKey of [0, 1, 0x7fffffff, 0xfffffffe]) {
			const spiral = behaviorForce(
				input({ behavior: 'spiral', velocity: [0, 0, 0], pairKey, spiralHandedness: -1 })
			);
			expect(spiral[0]).toBeGreaterThan(0);
			expect(spiral[2]).toBeGreaterThan(spiral[0]);
		}
	});
	it.each(['align', 'chase'] as const)(
		'a dense unrelated %s target does not dilute another rule',
		(otherBehavior) => {
			const scene = sceneFor();
			scene.speciesRules = [
				{ id: 'leader', from: 'observer', to: 'leader', behavior: 'align', strength: 1, radius: 4 },
				{
					id: 'other',
					from: 'observer',
					to: 'other',
					behavior: otherBehavior,
					strength: 1,
					radius: 4
				}
			];
			const observer = agent(1, 'observer', [0, 0, 0], [0, 0, 0]);
			const leader = agent(2, 'leader', [1, 0, 0], [0, 0, 1]);
			const other = agent(3, 'other', [1, 0, 0], [0, 1, 0]);
			const ordinary = interactionAccelerationsAllPairs(scene, [observer, leader, other])[0];
			const crowded = interactionAccelerationsAllPairs(scene, [
				observer,
				leader,
				...Array.from({ length: 100 }, (_, index) => ({ ...other, id: index + 3 }))
			])[0];
			for (let axis = 0; axis < 3; axis++) expect(crowded[axis]).toBeCloseTo(ordinary[axis], 12);
			expect(crowded[2]).toBeCloseTo(0.5625, 12);
		}
	);
	it('adds urgent escape threats while respecting the inherited rule caps', () => {
		const flee = behaviorForce(input({ behavior: 'flee', velocity: [0, 0, 0] }));
		expect(magnitude(combineDirectedResponse('flee', flee, 1, 2))).toBeCloseTo(3, 12);
		expect(magnitude(combineDirectedResponse('flee', scale(flee, 4), 4, 2))).toBeCloseTo(8, 12);
		expect(magnitude(combineDirectedResponse('disperse', [100, 0, 0], 100, 2))).toBeCloseTo(10, 12);
	});
	it('keeps explicit Ignore precedence and complete query results in the reference', () => {
		const scene = sceneFor();
		scene.speciesRules = [
			{ id: 'fallback', from: 'observer', to: '*', behavior: 'chase', strength: 1, radius: 10 },
			{ id: 'ignore', from: 'observer', to: 'leader', behavior: 'ignore', strength: 1, radius: 4 }
		];
		const agents = [
			agent(1, 'observer', [0, 0, 0], [0, 0, 0]),
			agent(2, 'leader', [1, 0, 0], [0, 0, 0]),
			agent(3, 'other', [7, 0, 0], [0, 0, 0])
		];
		const grid = createNeighborGrid(scene.world, agents, 2);
		expect(
			interactionAccelerationsAllPairs(scene, agents, undefined, (index, radius) =>
				grid.query(index, radius)
			)
		).toEqual(interactionAccelerationsAllPairs(scene, agents));
		expect(interactionAccelerationsAllPairs(scene, agents)[0][0]).toBeGreaterThan(0);
	});
	it('applies actual velocity matching through metric rules and excludes zero activation from their denominator', () => {
		const scene = sceneFor();
		scene.species[0].metricRules = [
			{
				id: 'metric',
				metric: 'speed',
				role: 'neighbor',
				range: [0, 1],
				curve: curvePreset('linear'),
				behavior: 'align',
				strength: 1,
				radius: 4
			}
		];
		const observer = agent(1, 'observer', [0, 0, 0], [0, 0, 0]);
		const active = agent(2, 'leader', [1, 0, 0], [0, 0, 1]);
		const inactive = agent(3, 'leader', [1, 0, 0], [0, 0, 0]);
		const pair = [observer, active],
			crowd = [
				observer,
				active,
				...Array.from({ length: 99 }, (_, index) => ({ ...inactive, id: index + 3 }))
			];
		expect(
			interactionAccelerationsAllPairs(scene, crowd, measureAllPairs(scene, crowd))[0]
		).toEqual(interactionAccelerationsAllPairs(scene, pair, measureAllPairs(scene, pair))[0]);
		const matched = [agent(1, 'observer', [0, 0, 0], [0, 0, 1]), active];
		expect(
			interactionAccelerationsAllPairs(scene, matched, measureAllPairs(scene, matched))[0]
		).toEqual([0, 0, 0]);
	});
	it.each(['align', 'mirror', 'cohere', 'flee', 'disperse', 'spiral'] as const)(
		'force zero disables %s acceleration',
		(behavior) => {
			expect(magnitude(behaviorForce(input({ behavior, force: 0 })))).toBe(0);
		}
	);
});

describe('local center flow measurements', () => {
	it('distinguishes radial approach, outward motion, and orbital motion with the inherited angle convention', () => {
		const scene = sceneFor();
		const measure = (velocity: Vec3) =>
			measureAllPairs(scene, [
				agent(1, 'observer', [0, 0, 0], velocity),
				agent(2, 'leader', [1, 0, 0], [0, 0, 0])
			])[0];
		expect(measure([1, 0, 0]).centerRadialSpeed).toBe(1);
		expect(measure([1, 0, 0]).centerOrbitAngle).toBeCloseTo(0, 12);
		expect(measure([-1, 0, 0]).centerRadialSpeed).toBe(-1);
		expect(measure([-1, 0, 0]).centerOrbitAngle).toBeCloseTo(0.5, 12);
		expect(measure([0, 0, 1]).centerOrbitAngle).toBeCloseTo(0.25, 12);
		expect(measure([0, 0, -1]).centerOrbitAngle).toBeCloseTo(0.75, 12);
		expect(measure([0, 0, 0]).centerOrbitAngle).toBe(0);
	});
	it('uses the configured volume axis rather than a fixed world-Y normal', () => {
		const scene = sceneFor();
		scene.dynamics.orbitAxis = [0, 0, 1];
		const [measured] = measureAllPairs(scene, [
			agent(1, 'observer', [0, 0, 0], [0, 1, 0]),
			agent(2, 'leader', [1, 0, 0], [0, 0, 0])
		]);
		expect(measured.centerOrbitAngle).toBeCloseTo(0.75, 12);
		expect(measured.centerRadialSpeed).toBe(0);
	});
	it.each([
		{ kind: 'surface', shape: 'sphere', radius: 10 },
		{ kind: 'surface', shape: 'cylinder', radius: 10, halfHeight: 12 },
		{ kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 }
	] satisfies WorldDefinition[])(
		'reads surface center motion in its own tangent plane on $shape',
		(world) => {
			const scene = sceneFor(world),
				origin: Vec3 = world.shape === 'torus' ? [28, 0, 0] : [10, 0, 0];
			const neighbor = worldExp(world, origin, [0, 0, 1]);
			const [measured] = measureAllPairs(scene, [
				agent(1, 'observer', origin, [0, 0, 1]),
				agent(2, 'leader', neighbor, [0, 0, 0])
			]);
			expect(dot([0, 0, 1], worldNormal(world, origin))).toBe(0);
			expect(measured.centerRadialSpeed).toBeCloseTo(1, 12);
			expect(measured.centerOrbitAngle).toBeCloseTo(0, 12);
		}
	);
	it('measures contrast against the magnitude of mean transported flow, permits ratios above one, and defines empty neighborhoods as zero', () => {
		const scene = sceneFor();
		scene.species[0].speed = 1;
		const observer = agent(1, 'observer', [0, 0, 0], [1, 0, 0]);
		const opposed = [
			observer,
			agent(2, 'leader', [1, 0, 0], [3, 0, 0]),
			agent(3, 'leader', [-1, 0, 0], [-3, 0, 0])
		];
		expect(measureAllPairs(scene, opposed)[0].speedContrast).toBe(1);
		expect(measureAllPairs(scene, opposed.slice(0, 2))[0].speedContrast).toBe(2);
		expect(measureAllPairs(scene, [observer])[0].speedContrast).toBe(0);
	});
	it('smooths orbit angles across their seam and smooths radial speed/contrast as scalars', () => {
		const scene = sceneFor(),
			snapshot = measureAllPairs(scene, [agent(1, 'observer', [0, 0, 0], [0, 0, 0])])[0];
		const filtered = smoothMetrics(
			{ ...snapshot, centerOrbitAngle: 0.01, centerRadialSpeed: 2, speedContrast: 2 },
			{ ...snapshot, centerOrbitAngle: 0.99, centerRadialSpeed: -2, speedContrast: 0 },
			0.5
		);
		expect(Math.min(filtered.centerOrbitAngle, 1 - filtered.centerOrbitAngle)).toBeLessThan(1e-12);
		expect(filtered.centerRadialSpeed).toBe(0);
		expect(filtered.speedContrast).toBe(1);
	});
});
