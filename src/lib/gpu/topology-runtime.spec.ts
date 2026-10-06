import { describe, expect, it } from 'vitest';
import {
	createDefaultScene,
	isSmoothTopologyWorld,
	smoothTopologySurface,
	smoothTopologyChart,
	smoothTopologyAdvance,
	initializePopulation,
	reconcilePopulation,
	topologyMesh,
	topologyPoint,
	topologyBarycentric,
	walkTopology,
	normalize,
	scale,
	subtract
} from '#lib/model';
import type { TopologyShape, AgentState } from '#lib/model';
import { packParticles, unpackParticles, HISTORY_SAMPLES } from './packing';
import { migrateRuntime } from './migration';

describe('topology runtime identity and world history', () => {
	it.each([0.06, 0.16])('initializes and packs agents on actual Trefoil thickness %s', (ratio) => {
		const scene = createDefaultScene();
		const world = {
			kind: 'surface' as const,
			shape: 'trefoil' as const,
			radius: 14,
			tubeRadius: 14 * ratio
		};
		scene.world = world;
		scene.species.forEach((species) => (species.population = 8));
		const population = initializePopulation(scene);
		const agents = unpackParticles(packParticles(population.agents, scene, 3), scene, 16);
		for (const agent of agents) {
			expect(agent.chart).toBeDefined();
			const surface = smoothTopologySurface(world, agent.chart!);
			expect(Math.hypot(...subtract(surface.position, agent.position))).toBeLessThan(2e-6);
			expect(agent.orientation).toBe(1);
			expect(
				Math.abs(surface.normal.reduce((sum, value, axis) => sum + value * agent.velocity[axis], 0))
			).toBeLessThan(1e-6);
		}
	});
	it.each(['mobius', 'klein', 'projective', 'trefoil'] as TopologyShape[])(
		'preserves %s sheet identity and orientation through buffer packing and population edits',
		(shape) => {
			const scene = createDefaultScene();
			scene.world = { kind: 'surface', shape, radius: 14 };
			scene.species.forEach((species) => (species.population = 4));
			const initial = initializePopulation(scene);
			initial.agents[0].orientation = -1;
			const agents = unpackParticles(packParticles(initial.agents, scene, 7), scene, 8);
			for (let i = 0; i < agents.length; i++) {
				expect(agents[i].id).toBe(initial.agents[i].id);
				expect(agents[i].triangle).toBe(initial.agents[i].triangle);
				expect(agents[i].orientation).toBe(initial.agents[i].orientation);
			}
			scene.species[0].population = 6;
			const resized = reconcilePopulation({ ...initial, agents }, scene);
			for (const agent of agents)
				expect(resized.agents.find((entry) => entry.id === agent.id)).toEqual(agent);
		}
	);
	it.each(['mobius', 'klein', 'projective', 'trefoil'] as TopologyShape[])(
		'keeps resampled %s trajectory points on their tagged surface and retains historical colors',
		(shape) => {
			const scene = createDefaultScene();
			const world = { kind: 'surface' as const, shape, radius: 14 };
			scene.world = world;
			const mesh = topologyMesh(world);
			const face = mesh.neighbors.findIndex((neighbors) => neighbors.every((value) => value >= 0));
			let origin = topologyPoint(mesh, face, [1 / 3, 1 / 3, 1 / 3]);
			const edge = topologyPoint(mesh, face, [0, 0.5, 0.5]);
			const displacement = scale(subtract(edge, origin), 1.7);
			const flatEnd = walkTopology(
				mesh,
				{ triangle: face, barycentric: [1 / 3, 1 / 3, 1 / 3] },
				displacement
			);
			expect(flatEnd.complete).toBe(true);
			let end = flatEnd;
			if (isSmoothTopologyWorld(world)) {
				const chart = smoothTopologyChart(world, origin, face);
				origin = smoothTopologySurface(world, chart).position;
				const motion = smoothTopologyAdvance(
					world,
					chart,
					displacement,
					displacement,
					displacement,
					1
				);
				end = { ...flatEnd, ...motion };
			}
			expect(end.triangle).not.toBe(face);
			const agent: AgentState = {
				id: 9,
				birth: 9,
				speciesKey: scene.species[0].key,
				position: end.position,
				velocity: normalize(end.velocity),
				triangle: end.triangle,
				orientation: -1
			};
			const history = new Float32Array(HISTORY_SAMPLES * 8);
			const colors = HISTORY_SAMPLES * 4;
			history.set([...end.position, 7], 0);
			history.set([...origin, 7], (HISTORY_SAMPLES - 1) * 4);
			history.set([1, 0.2, 0, end.triangle + 1], colors);
			history.set([0, 0.8, 1, face + 1], colors + (HISTORY_SAMPLES - 1) * 4);
			const result = migrateRuntime([agent], scene, 7, 1, {
				particles: packParticles([agent], scene, 7),
				metrics: new ArrayBuffer(64),
				history: history.buffer,
				head: 0,
				valid: 2,
				oldInterval: 1,
				newInterval: 0.25,
				headElapsed: 0
			});
			expect(result.valid).toBe(5);
			for (let age = 0; age < result.valid; age++) {
				const offset = ((HISTORY_SAMPLES - age) % HISTORY_SAMPLES) * 4;
				const tag = result.history[colors + offset + 3];
				expect(Number.isInteger(tag)).toBe(true);
				const point = Array.from(result.history.subarray(offset, offset + 3)) as [
					number,
					number,
					number
				];
				if (isSmoothTopologyWorld(world)) {
					const chart = smoothTopologyChart(world, point, tag - 1);
					expect(
						Math.hypot(...subtract(smoothTopologySurface(world, chart).position, point))
					).toBeLessThan(2e-6);
				} else {
					const coordinates = topologyBarycentric(mesh, tag - 1, point);
					expect(Math.min(...coordinates)).toBeGreaterThan(-1e-5);
					const projected = topologyPoint(mesh, tag - 1, coordinates);
					expect(Math.hypot(...subtract(projected, point))).toBeLessThan(2e-6);
				}
				expect(result.history[colors + offset]).toBeCloseTo(1 - age * 0.25, 6);
				expect(result.history[colors + offset + 2]).toBeCloseTo(age * 0.25, 6);
			}
			expect(new Float32Array(result.particles)[7]).toBe(-1);
		}
	);
});
