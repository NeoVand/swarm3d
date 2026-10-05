import { describe, it, expect } from 'vitest';
import { createDefaultScene, initializePopulation, torusPoint } from '#lib/model';
import type { AgentState } from '#lib/model';
import { packParticles } from './packing';
import { migrateRuntime } from './migration';

describe('runtime population migration', () => {
	it('retains velocity history and world trajectories by identity through reorder, removal and birth', () => {
		const scene = createDefaultScene();
		scene.species[0].population = 2;
		scene.species[1].population = 1;
		const old = initializePopulation(scene).agents;
		const state = packParticles(old, scene, 7);
		const f = new Float32Array(state);
		f.set([7, 8, 9], 8); // Previous transported velocity is distinct from the current velocity.
		const metrics = new Float32Array(48);
		metrics[1] = 2.7;
		metrics[16 + 1] = 4.8;
		const history = new Float32Array(3 * 64 * 8);
		old.forEach((agent, i) => {
			for (let age = 0; age < 64; age++) {
				history.set([agent.id, age, i, 7], (i * 64 + age) * 4);
				history.set([i / 4, age / 100, 0.6, 1], 3 * 64 * 4 + (i * 64 + age) * 4);
			}
		});
		const newborn = { ...old[0], id: 999, position: [4, 5, 6] as const };
		const result = migrateRuntime([old[1], newborn, old[0]], scene, 7, 4, {
			particles: state,
			metrics: metrics.buffer,
			history: history.buffer,
			head: 8,
			valid: 9,
			oldInterval: 1 / 30,
			newInterval: 1 / 60
		});
		const values = new Float32Array(result.particles),
			ids = new Uint32Array(result.particles);
		expect(Array.from(values.subarray(2 * 16 + 8, 2 * 16 + 11))).toEqual([7, 8, 9]);
		expect(ids[12]).toBe(old[1].id);
		expect(ids[16 + 12]).toBe(999);
		expect(result.metrics[1]).toBeCloseTo(4.8);
		expect(result.metrics[16]).toBe(-1);
		expect(result.history[8 * 4]).toBe(old[1].id);
		expect(Array.from(result.history.subarray((64 + 8) * 4, (64 + 8) * 4 + 4))).toEqual([
			4, 5, 6, 7
		]);
		expect(result.valid).toBe(17);
		const colorBase = 4 * 64 * 4;
		for (let age = 0; age < result.valid; age++) {
			const sample = (8 - age + 64) % 64;
			const retained = result.history.subarray(colorBase + sample * 4, colorBase + sample * 4 + 4);
			expect(retained[0]).toBeCloseTo(0.25, 6); // Old slot1 is new slot0.
			expect(retained[1]).toBeCloseTo((8 - age / 2) / 100, 6);
			expect(retained[2]).toBeCloseTo(0.6, 6);
			expect(retained[3]).toBe(1);
			expect(result.history[colorBase + (2 * 64 + sample) * 4]).toBe(0); // Old slot0.
		}
		expect(Array.from(result.history.subarray(colorBase + 64 * 4, colorBase + 128 * 4))).toEqual(
			Array(64 * 4).fill(0)
		);
		expect(Array.from(result.history.subarray(colorBase + 3 * 64 * 4))).toEqual(
			Array(64 * 4).fill(0)
		);
	});
	it('does not fabricate elapsed trajectory time when there is only one sample', () => {
		const scene = createDefaultScene();
		const agent = initializePopulation(scene).agents[0];
		const migrated = migrateRuntime([agent], scene, 1, 1, {
			particles: packParticles([agent], scene, 1),
			metrics: new ArrayBuffer(64),
			history: new ArrayBuffer(2048),
			head: 0,
			valid: 1,
			oldInterval: 1,
			newInterval: 0.1
		});
		expect(migrated.valid).toBe(1);
	});
	it.each([1, 2])(
		'preserves physical history time at tick59/stride3 when changing to stride%i',
		(stride) => {
			const scene = createDefaultScene();
			const agent: AgentState = {
				id: 9,
				speciesKey: 'shoal',
				birth: 9,
				position: [59 / 60, 0, 0],
				velocity: [1, 0, 0]
			};
			const state = packParticles([agent], scene, 7);
			new Float32Array(state).set([0.5, 0, 0], 8);
			const metrics = new Float32Array(16);
			metrics[1] = 2.7;
			const history = new Float32Array(64 * 8);
			const head = 1,
				valid = 4;
			for (let age = 0; age < valid; age++) {
				const time = (57 - 3 * age) / 60;
				const offset = ((head - age + 64) % 64) * 4;
				history.set([time, 0, 0, 7], offset);
				history.set([time, time * 0.2, 1 - time, 1], 64 * 4 + offset);
			}
			const newborn = { ...agent, id: 10, birth: 10, position: [4, 5, 6] as const };
			const migrated = migrateRuntime([agent, newborn], scene, 7, 2, {
				particles: state,
				metrics: metrics.buffer,
				history: history.buffer,
				head,
				valid,
				oldInterval: 3 / 60,
				newInterval: stride / 60,
				headElapsed: 2 / 60
			});
			expect(migrated.valid).toBe(Math.floor(11 / 60 / (stride / 60)) + 1);
			for (let age = 0; age < migrated.valid; age++) {
				const offset = ((head - age + 64) % 64) * 4;
				expect(migrated.history[offset]).toBeCloseTo((59 - age * stride) / 60, 6);
				expect(migrated.history[offset + 3]).toBe(7);
				const color = migrated.history.subarray(2 * 64 * 4 + offset, 2 * 64 * 4 + offset + 4);
				const sampledTime = Math.min(57 / 60, (59 - age * stride) / 60);
				expect(color[0]).toBeCloseTo(sampledTime, 6);
				expect(color[1]).toBeCloseTo(sampledTime * 0.2, 6);
				expect(color[2]).toBeCloseTo(1 - sampledTime, 6);
				expect(color[3]).toBe(1);
			}
			expect(new Float32Array(migrated.particles)[8]).toBe(0.5);
			expect(migrated.metrics[1]).toBeCloseTo(2.7, 6);
			expect(migrated.metrics[16]).toBe(-1);
			expect(Array.from(migrated.history.subarray(3 * 64 * 4))).toEqual(Array(64 * 4).fill(0));
			expect(Array.from(migrated.history.subarray((64 + head) * 4, (64 + head) * 4 + 4))).toEqual([
				4, 5, 6, 7
			]);
		}
	);
	it('projects interpolated sphere history onto the physical radius', () => {
		const scene = createDefaultScene();
		scene.world = { kind: 'surface', shape: 'sphere', radius: 5 };
		const agent: AgentState = {
			id: 9,
			speciesKey: 'shoal',
			birth: 9,
			position: [0, 5, 0],
			velocity: [1, 0, 0]
		};
		const history = new Float32Array(64 * 8);
		history.set([5, 0, 0, 7], 0);
		history.set([0, 0, 5, 7], 63 * 4);
		const migrated = migrateRuntime([agent], scene, 7, 1, {
			particles: packParticles([agent], scene, 7),
			metrics: new ArrayBuffer(64),
			history: history.buffer,
			head: 0,
			valid: 2,
			oldInterval: 0.04,
			newInterval: 0.02,
			headElapsed: 0.04
		});
		expect(migrated.valid).toBe(5);
		for (let age = 0; age < migrated.valid; age++) {
			const offset = ((64 - age) % 64) * 4;
			expect(Math.hypot(...migrated.history.subarray(offset, offset + 3))).toBeCloseTo(5, 6);
			expect(migrated.history[offset + 3]).toBe(7);
		}
		expect(migrated.history[63 * 4]).toBeCloseTo(5 / Math.sqrt(2), 6);
		expect(migrated.history[63 * 4 + 1]).toBeCloseTo(5 / Math.sqrt(2), 6);
		expect(migrated.history[61 * 4]).toBeCloseTo(5 / Math.sqrt(2), 6);
		expect(migrated.history[61 * 4 + 2]).toBeCloseTo(5 / Math.sqrt(2), 6);
	});
	it('interpolates periodic trajectories across the seam instead of through the box center', () => {
		const scene = createDefaultScene();
		scene.world = { kind: 'volume', shape: 'box', halfExtents: [2, 2, 2], boundaries: 'periodic' };
		const agent: AgentState = {
			id: 9,
			speciesKey: 'shoal',
			birth: 9,
			position: [1.8, 0, 0],
			velocity: [-1, 0, 0]
		};
		const history = new Float32Array(64 * 8);
		history.set([-1.8, 0, 0, 7], 0);
		const migrated = migrateRuntime([agent], scene, 7, 1, {
			particles: packParticles([agent], scene, 7),
			metrics: new ArrayBuffer(64),
			history: history.buffer,
			head: 0,
			valid: 1,
			oldInterval: 0.04,
			newInterval: 0.02,
			headElapsed: 0.04
		});
		expect(migrated.valid).toBe(3);
		expect(Math.abs(migrated.history[63 * 4])).toBeCloseTo(2, 6);
	});
	it('retains a cylinder trajectory on its surface across the angular seam', () => {
		const scene = createDefaultScene();
		scene.world = { kind: 'surface', shape: 'cylinder', radius: 5, halfHeight: 8 };
		const angle = Math.PI - 0.1;
		const agent: AgentState = {
			id: 9,
			speciesKey: 'shoal',
			birth: 9,
			position: [5 * Math.cos(angle), 2, 5 * Math.sin(angle)],
			velocity: [0, 1, 0]
		};
		const history = new Float32Array(64 * 8);
		history.set([5 * Math.cos(-angle), 0, 5 * Math.sin(-angle), 7]);
		const migrated = migrateRuntime([agent], scene, 7, 1, {
			particles: packParticles([agent], scene, 7),
			metrics: new ArrayBuffer(64),
			history: history.buffer,
			head: 0,
			valid: 1,
			oldInterval: 0.04,
			newInterval: 0.02,
			headElapsed: 0.04
		});
		const midpoint = migrated.history.subarray(63 * 4, 63 * 4 + 3);
		expect(midpoint[0]).toBeCloseTo(-5, 6);
		expect(midpoint[1]).toBeCloseTo(1, 6);
		expect(midpoint[2]).toBeCloseTo(0, 6);
		expect(Math.hypot(midpoint[0], midpoint[2])).toBeCloseTo(5, 6);
		expect(migrated.history[63 * 4 + 3]).toBe(7);
	});
	it('retains periodic plane history at the physical seam in the flat layer', () => {
		const scene = createDefaultScene();
		scene.world = { kind: 'surface', shape: 'plane', halfExtents: [2, 3], boundaries: 'periodic' };
		const agent: AgentState = {
			id: 9,
			speciesKey: 'shoal',
			birth: 9,
			position: [1.8, 0, 1],
			velocity: [-1, 0, 0]
		};
		const history = new Float32Array(64 * 8);
		history.set([-1.8, 0, 1, 7]);
		const migrated = migrateRuntime([agent], scene, 7, 1, {
			particles: packParticles([agent], scene, 7),
			metrics: new ArrayBuffer(64),
			history: history.buffer,
			head: 0,
			valid: 1,
			oldInterval: 0.04,
			newInterval: 0.02,
			headElapsed: 0.04
		});
		expect(Math.abs(migrated.history[63 * 4])).toBeCloseTo(2, 6);
		expect(migrated.history[63 * 4 + 1]).toBe(0);
		expect(migrated.history[63 * 4 + 2]).toBe(1);
	});
	it('interpolates torus history across both chart seams on the actual tube', () => {
		const scene = createDefaultScene();
		const world = { kind: 'surface', shape: 'torus', majorRadius: 6, tubeRadius: 2 } as const;
		scene.world = world;
		const agent: AgentState = {
			id: 9,
			speciesKey: 'shoal',
			birth: 9,
			position: torusPoint(world, { theta: Math.PI - 0.1, phi: Math.PI - 0.1 }),
			velocity: [0, 1, 0]
		};
		const history = new Float32Array(64 * 8);
		history.set([...torusPoint(world, { theta: -Math.PI + 0.1, phi: -Math.PI + 0.1 }), 7]);
		const migrated = migrateRuntime([agent], scene, 7, 1, {
			particles: packParticles([agent], scene, 7),
			metrics: new ArrayBuffer(64),
			history: history.buffer,
			head: 0,
			valid: 1,
			oldInterval: 0.04,
			newInterval: 0.02,
			headElapsed: 0.04
		});
		const midpoint = migrated.history.subarray(63 * 4, 63 * 4 + 4);
		expect(midpoint[0]).toBeCloseTo(-4, 6);
		expect(midpoint[1]).toBeCloseTo(0, 6);
		expect(midpoint[2]).toBeCloseTo(0, 6);
		expect(midpoint[3]).toBe(7);
	});
	it('explicit zero elapsed time anchors at preserved current state and caps valid history', () => {
		const scene = createDefaultScene();
		const agent: AgentState = {
			id: 9,
			speciesKey: 'shoal',
			birth: 9,
			position: [1, 2, 3],
			velocity: [1, 0, 0]
		};
		const migrated = migrateRuntime([agent], scene, 7, 1, {
			particles: packParticles([agent], scene, 7),
			metrics: new ArrayBuffer(64),
			history: new ArrayBuffer(2048),
			head: 0,
			valid: 64,
			oldInterval: 1,
			newInterval: 0.01,
			headElapsed: 0
		});
		expect(Array.from(migrated.history.subarray(0, 4))).toEqual([1, 2, 3, 7]);
		expect(migrated.valid).toBe(64);
	});
	it.each([-0.01, Infinity, NaN])('rejects invalid elapsed history time %s', (headElapsed) => {
		const scene = createDefaultScene();
		expect(() =>
			migrateRuntime([], scene, 7, 1, {
				particles: new ArrayBuffer(64),
				metrics: new ArrayBuffer(64),
				history: new ArrayBuffer(2048),
				head: 0,
				valid: 1,
				oldInterval: 1,
				newInterval: 1,
				headElapsed
			})
		).toThrow(/sampling times/);
	});
});
