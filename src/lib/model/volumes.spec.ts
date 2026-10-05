import { describe, expect, it } from 'vitest';
import {
	createDefaultScene,
	discoverScene,
	initializePopulation,
	worldAdvance,
	worldMeasure,
	volumeContact,
	worldBounds,
	worldDisplacement,
	worldTransport,
	createNeighborGrid,
	measureAllPairs,
	validateScene,
	cloneScene,
	type WorldDefinition,
	type Vec3
} from '#lib/model';
import { pickWorldRay } from '#lib/gpu/camera';
import { packConfig } from '#lib/gpu/packing';

const solids: WorldDefinition[] = [
	{ kind: 'volume', shape: 'sphere', radius: 6 },
	{ kind: 'volume', shape: 'cylinder', radius: 6, halfHeight: 8 },
	{ kind: 'volume', shape: 'torus', majorRadius: 16, tubeRadius: 6 }
];
const sceneFor = (world: WorldDefinition) => {
	const scene = createDefaultScene();
	scene.world = world;
	scene.species = [scene.species[0]];
	scene.speciesRules = [];
	scene.species[0].population = 8000;
	scene.species[0].size = 0.1;
	return scene;
};
describe('solid worlds use physical three-dimensional volumes', () => {
	it('keeps surface codes intact and assigns distinct solid codes and presentation flags', () => {
		expect(
			solids.map(
				(world) =>
					packConfig(sceneFor(world), {
						population: 1,
						tick: 0,
						historyHead: 0,
						validHistory: 1
					})[2]
			)
		).toEqual([5, 6, 7]);
		const scene = sceneFor(solids[0]);
		scene.visual.showGrid = true;
		scene.visual.theme = 'day';
		expect(packConfig(scene, { population: 1, tick: 0, historyHead: 0, validHistory: 1 })[63]).toBe(
			3
		);
		expect(worldMeasure(solids[0])).toBeCloseTo((4 * Math.PI * 216) / 3);
		expect(worldMeasure(solids[1])).toBeCloseTo(2 * Math.PI * 36 * 8);
		expect(worldMeasure(solids[2])).toBeCloseTo(2 * Math.PI ** 2 * 16 * 36);
		expect(solids.map(worldBounds)).toEqual([
			[6, 6, 6],
			[6, 8, 6],
			[22, 6, 22]
		]);
	});
	for (const world of solids) {
		it(`initializes ${world.shape} throughout its volume with the correct Jacobian`, () => {
			const scene = sceneFor(world),
				agents = initializePopulation(scene).agents;
			expect(agents).toEqual(initializePopulation(scene).agents);
			expect(
				agents.every(
					(agent) =>
						!volumeContact(
							world as Extract<WorldDefinition, { kind: 'volume' }>,
							agent.position,
							0.1
						).outside
				)
			).toBe(true);
			const mean = (f: (p: Vec3) => number) =>
				agents.reduce((sum, a) => sum + f(a.position), 0) / agents.length;
			if (world.shape === 'sphere')
				expect(mean((p) => p[0] ** 2 + p[1] ** 2 + p[2] ** 2) / 5.9 ** 2).toBeCloseTo(0.6, 1);
			if (world.shape === 'cylinder')
				expect(mean((p) => p[0] ** 2 + p[2] ** 2) / 5.9 ** 2).toBeCloseTo(0.5, 1);
			if (world.shape === 'torus') {
				expect(mean((p) => (Math.hypot(p[0], p[2]) - 16) ** 2 + p[1] ** 2) / 5.9 ** 2).toBeCloseTo(
					0.5,
					1
				);
				expect(
					Math.abs(mean((p) => Math.hypot(p[0], p[2]) - 16) - 5.9 ** 2 / (4 * 16))
				).toBeLessThan(0.15);
			}
			expect(agents.some((a) => Math.abs(a.velocity[1]) > 1)).toBe(true);
		});
		it(`contains repeated ${world.shape} motion and keeps speed through reflection`, () => {
			const scene = sceneFor(world);
			scene.species[0].population = 24;
			let agents = initializePopulation(scene).agents;
			for (let tick = 0; tick < 360; tick++)
				agents = agents.map((a) => {
					const motion = worldAdvance(world, a.position, a.velocity, 1 / 60, 0.1, a.velocity);
					expect(
						volumeContact(
							world as Extract<WorldDefinition, { kind: 'volume' }>,
							motion.position,
							0.1
						).distance
					).toBeLessThan(1e-10);
					expect(Math.hypot(...motion.velocity)).toBeCloseTo(Math.hypot(...a.velocity), 8);
					expect(motion.transportedPriorVelocity).toEqual(a.velocity);
					return { ...a, ...motion };
				});
		});
		it(`uses Euclidean neighbors and 3D density in ${world.shape}`, () => {
			const scene = sceneFor(world);
			scene.species[0].perception = 2;
			const origin: Vec3 = world.shape === 'torus' ? [16, 0, 0] : [0, 0, 0];
			const agents = [
				{
					id: 1,
					birth: 1,
					speciesKey: scene.species[0].key,
					position: origin,
					velocity: [0, 1, 0] as Vec3
				},
				{
					id: 2,
					birth: 2,
					speciesKey: scene.species[0].key,
					position: [origin[0] + 1, 0, 0] as Vec3,
					velocity: [0, 0, 1] as Vec3
				}
			];
			expect(worldDisplacement(world, agents[0].position, agents[1].position)).toEqual([1, 0, 0]);
			expect(worldTransport(world, [0, 1, 0], agents[1].position, agents[0].position)).toEqual([
				0, 1, 0
			]);
			expect(
				createNeighborGrid(world, agents, 1)
					.query(0, 2)
					.map((n) => n.id)
			).toEqual([2]);
			expect(measureAllPairs(scene, agents)[0].density).toBeCloseTo(1 / ((4 * Math.PI * 8) / 3));
		});
	}
	it('reflects an outward sphere contact but preserves an inward recovery velocity', () => {
		const world = solids[0];
		expect(worldAdvance(world, [5.8, 0, 0], [3, 0, 0], 0.1, 0.1).velocity).toEqual([-3, 0, 0]);
		expect(worldAdvance(world, [6.5, 0, 0], [-1, 0, 0], 0.1, 0.1).velocity).toEqual([-1, 0, 0]);
	});
	it('reflects both independent cylinder contacts at a cap/rim corner', () => {
		expect(worldAdvance(solids[1], [5.8, 7.8, 0], [3, 3, 0], 0.1, 0.1).velocity).toEqual([
			-3, -3, 0
		]);
	});
	it('uses the actual interior work plane rather than picking curved volume skins', () => {
		expect(pickWorldRay(solids[0], [0, 10, 0], [0, -1, 0], [0, 1, 0], 1)).toEqual({
			position: [0, 1, 0],
			normal: null
		});
		expect(pickWorldRay(solids[0], [5, 10, 5], [0, -1, 0])).toBeNull();
		expect(pickWorldRay(solids[1], [0, 10, 0], [0, -1, 0], [0, 1, 0], 1)).toEqual({
			position: [0, 1, 0],
			normal: null
		});
		expect(pickWorldRay(solids[2], [16, 10, 0], [0, -1, 0])).toEqual({
			position: [16, 0, 0],
			normal: null
		});
		expect(pickWorldRay(solids[2], [0, 10, 0], [0, -1, 0])).toBeNull();
	});
	it('permits obstacle/camera coordinates across the full largest torus envelope', () => {
		const scene = sceneFor({
			kind: 'volume',
			shape: 'torus',
			majorRadius: 10000,
			tubeRadius: 5000
		});
		scene.obstacles = [{ id: 'outer', shape: 'sphere', center: [14000, 0, 0], radius: 1 }];
		scene.camera.target = [14000, 0, 0];
		expect(validateScene(scene)).toMatchObject({ ok: true });
	});
	it('keeps discovery inhabitable for tiny volumes', () => {
		const tiny: WorldDefinition[] = [
			{ kind: 'volume', shape: 'box', halfExtents: [0.1, 0.1, 0.1], boundaries: 'reflect' },
			{ kind: 'volume', shape: 'sphere', radius: 0.1 },
			{ kind: 'volume', shape: 'cylinder', radius: 0.1, halfHeight: 0.1 },
			{ kind: 'volume', shape: 'torus', majorRadius: 2, tubeRadius: 1 }
		];
		for (const world of tiny) {
			const base = sceneFor(world);
			base.species[0].size = 0.01;
			expect(validateScene(base)).toMatchObject({ ok: true });
			for (const seed of [17, 91, 1005])
				expect(validateScene(discoverScene(seed, base))).toMatchObject({ ok: true });
		}
	});
	it('round-trips optional day/grid settings and rejects invalid or uninhabitable solids', () => {
		for (const world of solids) expect(validateScene(sceneFor(world))).toMatchObject({ ok: true });
		const scene = sceneFor(solids[0]);
		scene.visual.showGrid = true;
		scene.visual.theme = 'day';
		expect(validateScene(scene)).toMatchObject({ ok: true });
		const legacy = cloneScene(scene);
		delete legacy.visual.showGrid;
		delete legacy.visual.theme;
		expect(validateScene(legacy)).toMatchObject({ ok: true });
		scene.species[0].size = 6;
		expect(validateScene(scene).ok).toBe(false);
	});
});
