import { describe, expect, it } from 'vitest';
import type { SceneDefinition, TopologyShape } from './types';
import { createDefaultScene } from './defaults';
import { assertScene, validateScene } from './validation';
import { decodeSceneShare, encodeSceneShare, exportScene, importScene } from './serialization';
import { topologyMesh } from './topology-world';
import { topologyPoint } from './topology-mesh';
import { surfaceObstacleMargin } from './interactions';
import { worldInteractionLimit } from './geometry';
import { findSurfaceIntersections } from '../../../scripts/helpers/topology-fixtures';

const shapes: TopologyShape[] = ['mobius', 'klein', 'projective', 'trefoil'];
function sceneFor(shape: TopologyShape, radius = 14): SceneDefinition {
	const scene = createDefaultScene();
	scene.world = { kind: 'surface', shape, radius };
	scene.name = `${shape} · 世界`;
	for (const species of scene.species) {
		species.perception = radius * 0.1;
		species.size = Math.min(0.04, radius * 0.01);
		species.speed = 3.7;
		species.cruiseSpeed = 2;
	}
	scene.forces.radius = radius * 0.1;
	return scene;
}
function addObstacle(scene: SceneDefinition, triangle = 0) {
	if (scene.world.kind !== 'surface' || !shapes.includes(scene.world.shape as TopologyShape))
		throw new Error('Expected topology world.');
	const mesh = topologyMesh(scene.world as Extract<typeof scene.world, { shape: TopologyShape }>);
	scene.obstacles = [
		{
			id: 'brush',
			shape: 'sphere',
			center: topologyPoint(mesh, triangle, [1 / 3, 1 / 3, 1 / 3]),
			radius: 0.05,
			triangle
		}
	];
	return scene;
}
const failure = (scene: unknown) => {
	const result = validateScene(scene);
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.issues;
};

describe('triangulated surface scene contract', () => {
	it.each(shapes)('round-trips %s geometry, Unicode, picked obstacles and framing', (shape) => {
		const scene = addObstacle(sceneFor(shape));
		scene.camera.pan = [0.2, -0.3];
		const parsed = assertScene(scene);
		expect(importScene(exportScene(parsed))).toEqual(parsed);
		expect(decodeSceneShare(encodeSceneShare(parsed))).toEqual(parsed);
		expect(scene.obstacles[0].triangle).toBe(0);
	});
	it.each(shapes)('normalizes an omitted %s obstacle face without mutating source', (shape) => {
		const scene = addObstacle(sceneFor(shape));
		delete scene.obstacles[0].triangle;
		const parsed = assertScene(scene);
		expect(parsed.obstacles[0].triangle).toBe(0);
		expect(scene.obstacles[0].triangle).toBeUndefined();
	});
	it.each(shapes)('rejects off-mesh and wrong-sheet %s obstacle centers', (shape) => {
		const scene = addObstacle(sceneFor(shape));
		scene.obstacles[0].center = [100, 100, 100];
		expect(failure(scene).some((issue) => issue.path === 'scene.obstacles[0].center')).toBe(true);
		delete scene.obstacles[0].triangle;
		expect(failure(scene).some((issue) => issue.message.includes('surface mesh'))).toBe(true);
		const wrong = addObstacle(sceneFor(shape));
		wrong.obstacles[0].triangle = Math.floor(
			topologyMesh(wrong.world as Extract<typeof wrong.world, { shape: TopologyShape }>).triangles
				.length / 2
		);
		expect(failure(wrong).some((issue) => issue.message.includes('declared triangle'))).toBe(true);
	});
	it.each(shapes)('validates %s face identity against the actual tessellation', (shape) => {
		const scene = addObstacle(sceneFor(shape));
		const count = topologyMesh(scene.world as Extract<typeof scene.world, { shape: TopologyShape }>)
			.triangles.length;
		for (const triangle of [-1, 0.5, count, 100001, NaN]) {
			scene.obstacles[0].triangle = triangle;
			expect(failure(scene).some((issue) => issue.path === 'scene.obstacles[0].triangle')).toBe(
				true
			);
		}
	});
	it.each(['klein', 'projective'] as const)(
		'preserves explicit %s identity at a self intersection',
		(shape) => {
			const scene = sceneFor(shape),
				mesh = topologyMesh(scene.world as Extract<typeof scene.world, { shape: TopologyShape }>);
			const intersections = findSurfaceIntersections(mesh);
			expect(intersections).toHaveLength(8);
			for (const fixture of intersections) {
				for (const triangle of [fixture.fromTriangle, fixture.toTriangle]) {
					scene.obstacles = [
						{ id: 'crossing', shape: 'sphere', center: fixture.point, radius: 0.05, triangle }
					];
					expect(assertScene(scene).obstacles[0].triangle).toBe(triangle);
					expect(importScene(exportScene(scene)).obstacles[0].triangle).toBe(triangle);
				}
			}
		}
	);
	it('converts an obstacle-free prerelease double torus into the trefoil without changing its source', () => {
		const source = {
			...sceneFor('trefoil'),
			world: { kind: 'surface', shape: 'genus2', radius: 14 }
		};
		const before = structuredClone(source);
		const normalized = assertScene(source);
		expect(normalized.world).toEqual({ kind: 'surface', shape: 'trefoil', radius: 14 });
		expect(source).toEqual(before);
		expect(importScene(exportScene(source as unknown as SceneDefinition)).world).toEqual(
			normalized.world
		);
	});
	it('rejects prerelease double-torus obstacle tags that cannot be transferred to the trefoil', () => {
		const source = {
			...addObstacle(sceneFor('trefoil')),
			world: { kind: 'surface', shape: 'genus2', radius: 14 }
		};
		const before = structuredClone(source);
		expect(
			failure(source).some((issue) => issue.message.includes('Remove its old surface obstacles'))
		).toBe(true);
		expect(source).toEqual(before);
	});
	it.each(shapes)('validates full %s avoidance reach and reserves a usable brush', (shape) => {
		const scene = addObstacle(sceneFor(shape)),
			limit = worldInteractionLimit(scene.world),
			margin = surfaceObstacleMargin(scene);
		if (scene.obstacles[0].shape !== 'sphere') throw new Error('Expected disk.');
		scene.obstacles[0].radius = limit - margin;
		expect(
			failure(scene).some((issue) => issue.message.includes('including body and avoidance margins'))
		).toBe(true);
		scene.obstacles[0].radius = limit - margin - 0.001;
		expect(validateScene(scene).ok).toBe(true);
		scene.obstacleSettings.enabled = false;
		scene.species.forEach((species) => (species.size = limit * 0.201));
		expect(
			failure(scene).some((issue) => issue.message.includes('positive legal obstacle radius'))
		).toBe(true);
	});
	it.each(shapes)('limits %s physical tick travel independently of display time scale', (shape) => {
		const scene = sceneFor(shape),
			limit = worldInteractionLimit(scene.world);
		scene.dynamics.fixedDt = 0.1;
		scene.dynamics.timeScale = 0.01;
		scene.species[0].speed = limit / scene.dynamics.fixedDt;
		expect(
			failure(scene).some(
				(issue) => issue.path === 'scene.species[0].speed' && issue.message.includes('tick')
			)
		).toBe(true);
		scene.species[0].speed *= 0.999;
		expect(validateScene(scene).ok).toBe(true);
		scene.dynamics.timeScale = 4;
		expect(validateScene(scene).ok).toBe(true);
	});
	it.each(shapes)(
		'supports finite %s scale bounds and rejects malformed world definitions',
		(shape) => {
			for (const radius of [2, 10000]) expect(validateScene(sceneFor(shape, radius)).ok).toBe(true);
			for (const radius of [1.999, 10000.1, -1, NaN, Infinity])
				expect(
					failure({ ...sceneFor(shape), world: { kind: 'surface', shape, radius } }).some(
						(issue) => issue.path === 'scene.world.radius'
					)
				).toBe(true);
			expect(
				failure({ ...sceneFor(shape), world: { kind: 'volume', shape, radius: 14 } }).some(
					(issue) => issue.path === 'scene.world.shape'
				)
			).toBe(true);
			expect(
				failure({
					...sceneFor(shape),
					world: { kind: 'surface', shape, radius: 14, tubeRadius: 2 }
				}).some((issue) => issue.path === 'scene.world')
			).toBe(true);
		}
	);
	it('preserves inactive rule ranges while validating their next active state', () => {
		const scene = sceneFor('klein');
		scene.speciesRules[0].behavior = 'ignore';
		scene.speciesRules[0].radius = 1000;
		scene.species[0].metricRules = [
			{
				id: 'inactive',
				metric: 'speed',
				role: 'self',
				range: [0, 10],
				curve: {
					points: [
						[0, 0],
						[1, 1]
					]
				},
				behavior: 'flee',
				strength: 0,
				radius: 1000
			}
		];
		expect(validateScene(scene).ok).toBe(true);
		scene.speciesRules[0].behavior = 'flee';
		expect(failure(scene).some((issue) => issue.path === 'scene.speciesRules[0].radius')).toBe(
			true
		);
		scene.speciesRules[0].behavior = 'ignore';
		scene.species[0].metricRules[0].strength = 1;
		expect(
			failure(scene).some((issue) => issue.path === 'scene.species[0].metricRules[0].radius')
		).toBe(true);
	});

	it('rejects triangle tags on worlds whose surfaces have no face identities', () => {
		const scene = createDefaultScene();
		scene.obstacles = [{ id: 'solid', shape: 'sphere', center: [0, 0, 0], radius: 1, triangle: 0 }];
		expect(
			failure(scene).some(
				(issue) => issue.path === 'scene.obstacles[0].triangle' && issue.message.includes('only')
			)
		).toBe(true);
	});
});
