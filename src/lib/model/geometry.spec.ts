import { describe, expect, it } from 'vitest';
import type { AgentState, Vec3, WorldDefinition } from '#lib/model/types';
import {
	allPairsNeighbors,
	add,
	createNeighborGrid,
	dot,
	magnitude,
	sphereAdvance,
	sphereDistance,
	sphereExp,
	sphereLog,
	sphereTransport,
	worldDisplacement
} from '#lib/model/geometry';
import { createDefaultScene } from '#lib/model/defaults';
import { initializePopulation, resizePopulation } from '#lib/model/population';
import { measureAllPairs, smoothMetrics } from '#lib/model/oracles';

const agent = (id: number, position: Vec3, velocity: Vec3 = [1, 0, 0]): AgentState => ({
	id,
	birth: id,
	speciesKey: 'shoal',
	position,
	velocity
});

describe('sphere geometry', () => {
	it('inverts exponential/log maps and preserves transport norm and tangency', () => {
		const p: Vec3 = [0, 0, 12],
			v: Vec3 = [3, 4, 0];
		const q = sphereExp(p, v, 12);
		const recovered = sphereLog(p, q, 12);
		const transported = sphereTransport(v, p, q);
		expect(magnitude(q)).toBeCloseTo(12, 12);
		expect(recovered[0]).toBeCloseTo(3, 12);
		expect(recovered[1]).toBeCloseTo(4, 12);
		expect(sphereDistance(p, q, 12)).toBeCloseTo(5, 12);
		expect(magnitude(transported)).toBeCloseTo(5, 12);
		expect(dot(transported, q)).toBeCloseTo(0, 11);
		expect(sphereTransport(transported, q, p)[0]).toBeCloseTo(3, 12);
	});
	it('rejects an arbitrary antipodal direction and remains finite at coincidence', () => {
		expect(() => sphereLog([0, 1, 0], [0, -1, 0], 1)).toThrow(/Antipodal/);
		expect(() => sphereTransport([1, 0, 0], [0, 1, 0], [0, -1, 0])).toThrow(/antipodal/);
		expect(sphereLog([0, 1, 0], [0, 1, 0], 1)).toEqual([0, 0, 0]);
	});
	it('can transport velocity along a chosen step arc at the antipodal endpoint', () => {
		const next = sphereAdvance([1, 0, 0], [0, 0, Math.PI], 1, 1);
		expect(next.position[0]).toBeCloseTo(-1, 12);
		expect(next.velocity[2]).toBeCloseTo(-Math.PI, 12);
		expect(dot(next.position, next.velocity)).toBeCloseTo(0, 12);
	});
	it('free great-circle motion has no covariant steering acceleration or turn', () => {
		const scene = resizePopulation(createDefaultScene(), 1);
		scene.world = { kind: 'surface', shape: 'sphere', radius: 12 };
		const before = [agent(1, [0, 0, 12], [3, 0, 0])];
		const advanced = sphereAdvance(before[0].position, before[0].velocity, 1 / 60, 12);
		const after = [{ ...before[0], ...advanced }];
		const [metrics] = measureAllPairs(scene, after, before);
		expect(metrics.turnRate).toBeLessThan(1e-5);
		expect(metrics.acceleration).toBeLessThan(1e-10);
		let current = advanced;
		for (let i = 0; i < 119; i++)
			current = sphereAdvance(current.position, current.velocity, 1 / 60, 12);
		expect(current.position[0]).toBeCloseTo(12 * Math.sin(0.5), 10);
		expect(current.position[2]).toBeCloseTo(12 * Math.cos(0.5), 10);
	});
});

describe('complete neighbor grid', () => {
	it.each<WorldDefinition>([
		{ kind: 'volume', shape: 'box', halfExtents: [2.3, 3.1, 4.7], boundaries: 'reflect' },
		{ kind: 'volume', shape: 'box', halfExtents: [2.3, 3.1, 4.7], boundaries: 'periodic' },
		{ kind: 'surface', shape: 'sphere', radius: 5 }
	])('matches all pairs for $kind / $shape, including cell boundaries', (world) => {
		const scene = resizePopulation(createDefaultScene(), 150);
		scene.world = world;
		const agents = initializePopulation(scene).agents;
		const grid = createNeighborGrid(world, agents, 1.4);
		for (let i = 0; i < agents.length; i += 7) {
			const expected = allPairsNeighbors(world, agents, i, 2.5)
				.map((item) => item.id)
				.sort((a, b) => a - b);
			expect(grid.query(i, 2.5).map((item) => item.id)).toEqual(expected);
		}
	});
	it('includes more than 64 colocated agents and counts periodic neighbors once', () => {
		const world: WorldDefinition = {
			kind: 'volume',
			shape: 'box',
			halfExtents: [1, 1, 1],
			boundaries: 'periodic'
		};
		const agents = Array.from({ length: 180 }, (_, i) => agent(i + 1, [0, 0, 0]));
		const neighbors = createNeighborGrid(world, agents, 0.9).query(0, 4);
		expect(neighbors).toHaveLength(179);
		expect(new Set(neighbors.map((item) => item.id)).size).toBe(179);
		expect(neighbors.every((item) => item.distance === 0)).toBe(true);
	});
	it('keeps periodic half-period ties antisymmetric', () => {
		const world: WorldDefinition = {
			kind: 'volume',
			shape: 'box',
			halfExtents: [2, 2, 2],
			boundaries: 'periodic'
		};
		expect(
			magnitude(
				add(
					worldDisplacement(world, [0, 0, 0], [2, 0, 0]),
					worldDisplacement(world, [2, 0, 0], [0, 0, 0])
				)
			)
		).toBe(0);
	});
});

describe('honest snapshot metrics', () => {
	it('distinguishes isotropic, sheet-like and filament neighborhoods', () => {
		const scene = createDefaultScene();
		scene.species[0].perception = 3;
		const origin = agent(1, [0, 0, 0]);
		const axes = [
			[1, 0, 0],
			[-1, 0, 0],
			[0, 1, 0],
			[0, -1, 0],
			[0, 0, 1],
			[0, 0, -1]
		] as Vec3[];
		const measure = (points: Vec3[]) =>
			measureAllPairs(scene, [origin, ...points.map((point, i) => agent(i + 2, point))])[0];
		expect(measure(axes).anisotropy).toBeCloseTo(0, 12);
		expect(measure([axes[0], axes[1], axes[4], axes[5]]).anisotropy).toBeCloseTo(0.25, 12);
		expect(measure([axes[0], axes[1]]).anisotropy).toBeCloseTo(1, 12);
		expect(measure(axes).density).toBeCloseTo(6 / ((4 * Math.PI * 27) / 3), 12);
	});
	it('keeps counts/density/speed instantaneous and blends circular fields across the seam', () => {
		const scene = createDefaultScene();
		const current = measureAllPairs(scene, [agent(1, [0, 0, 0])])[0];
		const result = smoothMetrics(
			{ ...current, centerBearing: 0.01, speed: 7, neighborCount: 9, density: 4 },
			{ ...current, centerBearing: 0.99, speed: 2, neighborCount: 1, density: 1 },
			0.5
		);
		expect(Math.min(result.centerBearing, 1 - result.centerBearing)).toBeLessThan(1e-12);
		expect([result.speed, result.neighborCount, result.density]).toEqual([7, 9, 4]);
	});
});
