import { describe, expect, it } from 'vitest';
import { CURATED_SCENES, createDefaultScene, discoverScene } from '#lib/model/defaults';
import { CURVE_PRESETS, curvePreset, evaluateCurve, sampleCurve } from '#lib/model/curves';
import { dot, magnitude } from '#lib/model/geometry';
import {
	initializePopulation,
	largestRemainder,
	reconcilePopulation,
	resizePopulation
} from '#lib/model/population';
import { assertScene, validateScene } from '#lib/model/validation';
import {
	decodeSceneShare,
	encodeSceneShare,
	exportScene,
	importScene
} from '#lib/model/serialization';
import { createMemorySceneRepository } from '#lib/model/repository';
import { maximumNeighborRadius, resolveDirectedRule } from '#lib/model/oracles';

describe('scene format and discovery', () => {
	it('validates every curated scene and deterministic discovery in both domains', () => {
		expect(CURATED_SCENES.map((scene) => assertScene(scene).name)).toContain('Small Planet');
		for (const scene of CURATED_SCENES)
			for (let seed = 0; seed < 12; seed++) {
				const discovered = discoverScene(seed, scene);
				expect(validateScene(discovered).ok).toBe(true);
				expect(discovered).toEqual(discoverScene(seed, scene));
				expect(discovered.species.reduce((sum, species) => sum + species.population, 0)).toBe(5000);
			}
	});
	it('rejects nonfinite values, unknown references, legacy scenes and unsafe sphere ranges', () => {
		const scene = createDefaultScene();
		scene.species[0].speed = NaN;
		expect(validateScene(scene).ok).toBe(false);
		scene.species[0].speed = 4;
		scene.speciesRules = [
			{ id: 'missing', from: 'shoal', to: 'absent', behavior: 'chase', strength: 1, radius: null }
		];
		expect(() => assertScene(scene)).toThrow(/Unknown target species/);
		scene.speciesRules = [];
		scene.world = { kind: 'surface', shape: 'sphere', radius: 2 };
		expect(() => assertScene(scene)).toThrow(/πR\/2/);
		expect(validateScene({ version: 0, boids: [] }).ok).toBe(false);
	});
	it('round-trips unicode scene JSON and URL-safe share payloads', () => {
		const scene = createDefaultScene();
		scene.name = '海 • Water ✦';
		expect(importScene(exportScene(scene))).toEqual(scene);
		const encoded = encodeSceneShare(scene);
		expect(encoded).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(decodeSceneShare(`#scene=${encoded}`)).toEqual(scene);
		expect(() => decodeSceneShare('%%')).toThrow();
	});
	it('normalizes missing prerelease-v1 cruise targets without mutating the source and exports them', () => {
		const old = structuredClone(createDefaultScene()) as unknown as {
			species: Record<string, unknown>[];
		};
		for (const species of old.species) {
			delete species.cruiseSpeed;
			Object.freeze(species);
		}
		const normalized = assertScene(old);
		for (const [index, species] of normalized.species.entries()) {
			expect(species.cruiseSpeed).toBeCloseTo(0.3 * species.speed, 12);
			expect(Object.hasOwn(old.species[index], 'cruiseSpeed')).toBe(false);
		}
		expect(importScene(JSON.stringify(old))).toEqual(normalized);
		expect(importScene(exportScene(normalized))).toEqual(normalized);
		expect(decodeSceneShare(encodeSceneShare(normalized))).toEqual(normalized);
	});
	it('keeps explicit cruise targets, including zero and the maximum, through validation and shares', () => {
		const scene = createDefaultScene();
		scene.species[0].cruiseSpeed = 0;
		scene.species[0].force = 0;
		scene.species[1].cruiseSpeed = scene.species[1].speed;
		expect(assertScene(scene)).toEqual(scene);
		expect(decodeSceneShare(encodeSceneShare(scene))).toEqual(scene);
	});
	it.each([-0.01, NaN, Infinity, -Infinity, null, undefined, '1.2'])(
		'rejects an explicit invalid cruise target %s rather than defaulting or clamping it',
		(value) => {
			const scene = createDefaultScene();
			(scene.species[0] as unknown as Record<string, unknown>).cruiseSpeed = value;
			const result = validateScene(scene);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.issues.some((issue) => issue.path === 'scene.species[0].cruiseSpeed')).toBe(
					true
				);
		}
	);
	it('rejects a cruise target above the actual speed cap', () => {
		const scene = createDefaultScene();
		scene.species[0].cruiseSpeed = scene.species[0].speed + 0.01;
		const result = validateScene(scene);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues.some((issue) => issue.path === 'scene.species[0].cruiseSpeed')).toBe(
				true
			);
	});
	it('permits bounded authored cruise targets in curated scenes and discovery', () => {
		for (const scene of [...CURATED_SCENES, discoverScene(0xffffffff)])
			for (const species of scene.species) {
				expect(species.cruiseSpeed).toBeGreaterThanOrEqual(0);
				expect(species.cruiseSpeed).toBeLessThanOrEqual(species.speed);
			}
	});
	it('normalizes missing prerelease visual quality without changing physical settings', () => {
		const scene = createDefaultScene();
		const old = structuredClone(scene) as unknown as { visual: Record<string, unknown> };
		delete old.visual.quality;
		Object.freeze(old.visual);
		const normalized = importScene(JSON.stringify(old));
		expect(normalized).toEqual(scene);
		expect(Object.hasOwn(old.visual, 'quality')).toBe(false);
		expect(importScene(exportScene(normalized))).toEqual(scene);
	});
	it.each(['balanced', 'sharp'] as const)(
		'round-trips %s quality as presentation state while preserving the physical scene',
		(quality) => {
			const scene = createDefaultScene();
			scene.visual.quality = quality;
			const decoded = decodeSceneShare(encodeSceneShare(scene));
			expect(decoded.visual.quality).toBe(quality);
			expect(decoded.species).toEqual(scene.species);
			expect(decoded.speciesRules).toEqual(scene.speciesRules);
			expect(decoded.dynamics).toEqual(scene.dynamics);
		}
	);
	it.each(['low', 'ultra', undefined, null, 1])(
		'rejects explicit invalid quality %s',
		(quality) => {
			const scene = createDefaultScene();
			(scene.visual as unknown as Record<string, unknown>).quality = quality;
			const result = validateScene(scene);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.issues.some((issue) => issue.path === 'scene.visual.quality')).toBe(true);
		}
	);
	it('accepts surface caps only on their intrinsic center and within a unique local range', () => {
		const scene = createDefaultScene();
		scene.world = { kind: 'surface', shape: 'sphere', radius: 16 };
		scene.obstacles = [{ id: 'cap', shape: 'sphere', center: [0, 16, 0], radius: 2 }];
		expect(validateScene(scene).ok).toBe(true);
		scene.obstacles[0].center = [0, 8, 0];
		expect(() => assertScene(scene)).toThrow(/center must lie/);
		scene.obstacles = [{ id: 'cap', shape: 'sphere', center: [0, 16, 0], radius: Math.PI * 8 }];
		expect(() => assertScene(scene)).toThrow(/πR\/2/);
		scene.obstacles = [{ id: 'box', shape: 'box', center: [0, 16, 0], halfExtents: [1, 1, 1] }];
		expect(() => assertScene(scene)).toThrow(/geodesic cap/);
	});
	it('explicit Ignore wins over a wildcard in either order', () => {
		const scene = createDefaultScene();
		scene.speciesRules = [
			{ id: 'all', from: 'shoal', to: '*', behavior: 'chase', strength: 1, radius: null },
			{ id: 'exception', from: 'shoal', to: 'amber', behavior: 'ignore', strength: 1, radius: null }
		];
		expect(resolveDirectedRule(scene, 'shoal', 'amber')?.behavior).toBe('ignore');
		scene.speciesRules.reverse();
		expect(resolveDirectedRule(scene, 'shoal', 'amber')?.behavior).toBe('ignore');
	});
	it('covers larger-body positional contacts even with soft collision disabled', () => {
		const scene = createDefaultScene();
		scene.species[0].perception = 0.25;
		scene.species[0].size = 0.1;
		scene.species[1].size = 1.2;
		scene.dynamics.collision = 0;
		expect(maximumNeighborRadius(scene, 'shoal', 0)).toBeCloseTo(1.3, 12);
		scene.dynamics.collision = 1;
		expect(maximumNeighborRadius(scene, 'shoal', 1.2)).toBeCloseTo(1.56, 12);
	});
});

describe('stable population identity', () => {
	it('rejects exhausted uint32 IDs with a new-run instruction instead of wrapping or aliasing', () => {
		const scene = resizePopulation(createDefaultScene(), 1);
		const exhausted = { agents: [], nextId: 0x100000000, generation: 2 };
		expect(() => reconcilePopulation(exhausted, scene)).toThrow(
			'Agent ID capacity exhausted; start a new run generation.'
		);
		expect(() => reconcilePopulation({ ...exhausted, nextId: 0xffffffff }, scene)).toThrow(
			/start a new run generation/
		);
		expect(exhausted.agents).toEqual([]);
		expect(exhausted.nextId).toBe(0x100000000);
	});
	it('preserves the final allocatable ID without allowing its counter to wrap', () => {
		const scene = resizePopulation(createDefaultScene(), 1);
		const last = reconcilePopulation({ agents: [], nextId: 0xfffffffe, generation: 2 }, scene);
		expect(last.agents[0].id).toBe(0xfffffffe);
		expect(last.nextId).toBe(0xffffffff);
		expect(reconcilePopulation(last, scene)).toEqual(last);
		expect(() => reconcilePopulation(last, resizePopulation(scene, 2))).toThrow(
			/start a new run generation/
		);
		expect(last.agents).toHaveLength(1);
		expect(last.nextId).toBe(0xffffffff);
	});
	it('allocates an exact total, including zero and enormous finite weights', () => {
		expect(largestRemainder(7, [1, 1, 1])).toEqual([3, 2, 2]);
		expect(largestRemainder(4, [0, 0, 0])).toEqual([2, 1, 1]);
		expect(largestRemainder(3, [Number.MAX_VALUE, Number.MAX_VALUE])).toEqual([2, 1]);
		expect(largestRemainder(0, [1, 2])).toEqual([0, 0]);
		expect(() => largestRemainder(2.5, [1])).toThrow();
	});
	it('preserves survivor state through growth, shrinkage and storage reordering', () => {
		const scene = resizePopulation(createDefaultScene(), 18);
		const population = initializePopulation(scene, 4);
		const grown = reconcilePopulation(
			{ ...population, agents: [...population.agents].reverse() },
			resizePopulation(scene, 30)
		);
		for (const original of population.agents)
			expect(grown.agents.find((agent) => agent.id === original.id)).toEqual(original);
		const reduced = reconcilePopulation(grown, resizePopulation(scene, 8));
		expect(reduced.agents).toHaveLength(8);
		expect(reduced.generation).toBe(4);
		expect(reduced.nextId).toBe(grown.nextId);
		const regrown = reconcilePopulation(reduced, resizePopulation(scene, 20));
		expect(
			regrown.agents
				.filter((agent) => !reduced.agents.some((old) => old.id === agent.id))
				.every((agent) => agent.id >= grown.nextId)
		).toBe(true);
	});
	it('initializes sphere positions uniformly without poles and tangent velocities', () => {
		const scene = resizePopulation(createDefaultScene(), 1800);
		scene.world = { kind: 'surface', shape: 'sphere', radius: 16 };
		const population = initializePopulation(scene);
		const y = population.agents.map((agent) => agent.position[1] / 16);
		expect(y.reduce((sum, value) => sum + value, 0) / y.length).toBeCloseTo(0, 1);
		expect(y.reduce((sum, value) => sum + value * value, 0) / y.length).toBeCloseTo(1 / 3, 1);
		for (const agent of population.agents.slice(0, 50)) {
			expect(magnitude(agent.position)).toBeCloseTo(16, 11);
			expect(dot(agent.position, agent.velocity)).toBeCloseTo(0, 10);
		}
		expect(initializePopulation(scene)).toEqual(population);
	});
});

describe('shape-preserving response curves', () => {
	it('preserves all nine presets and never invents interval extrema', () => {
		expect(CURVE_PRESETS).toHaveLength(9);
		for (const preset of CURVE_PRESETS)
			for (let interval = 0; interval < preset.curve.points.length - 1; interval++) {
				const [x0, y0] = preset.curve.points[interval],
					[x1, y1] = preset.curve.points[interval + 1];
				let previous = y0;
				for (let i = 0; i <= 20; i++) {
					const value = evaluateCurve(preset.curve, x0 + ((x1 - x0) * i) / 20);
					expect(value).toBeGreaterThanOrEqual(Math.min(y0, y1) - 1e-12);
					expect(value).toBeLessThanOrEqual(Math.max(y0, y1) + 1e-12);
					expect((value - previous) * Math.sign(y1 - y0)).toBeGreaterThanOrEqual(-1e-12);
					previous = value;
				}
			}
		expect(evaluateCurve(curvePreset('bell'), 0.5)).toBeCloseTo(0.8, 12);
		expect(sampleCurve(curvePreset('bowl'), 33)[16]).toBeCloseTo(0.2, 6);
	});
});

describe('scene repository undo contract', () => {
	it('updates atomically, preserves metadata, clones callers and restores a deleted record', async () => {
		let clock = 100;
		const repository = createMemorySceneRepository(() => clock);
		const scene = createDefaultScene();
		const first = await repository.put(scene);
		clock = 200;
		scene.name = 'Renamed';
		const updated = await repository.put(scene);
		expect(updated.createdAt).toBe(first.createdAt);
		expect(updated.updatedAt).toBe(200);
		updated.scene.name = 'Caller mutation';
		expect((await repository.get(scene.id))?.name).toBe('Renamed');
		const removed = await repository.remove(scene.id);
		expect(await repository.list()).toEqual([]);
		await repository.restore(removed!);
		expect(await repository.get(scene.id)).toEqual(removed);
		await expect(repository.restore(removed!)).rejects.toThrow(/already exists/);
		scene.species[0].force = Infinity;
		await expect(repository.put(scene)).rejects.toThrow();
		expect(await repository.get(scene.id)).toEqual(removed);
	});
});
