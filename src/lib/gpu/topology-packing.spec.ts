import { describe, expect, it, vi } from 'vitest';
import {
	createDefaultScene,
	isTopologyWorld,
	trefoilTubeRatio,
	worldInteractionLimit
} from '#lib/model';
import * as meshModule from '#lib/model/topology-mesh';
import type { SceneDefinition, TopologyShape } from '#lib/model';
import { createTopologyMesh } from '#lib/model/topology-mesh';
import { createTopologyRelations } from '#lib/model/topology-relations';
import { topologyGridCounts } from '#lib/model/topology-chart';
import { packSmoothTopologyField } from '#lib/model/topology-smooth';
import { packTopologyDisplayNormals } from './topology-display-normals';
import { packConfig } from './packing';
import { packTopology } from './topology';

const shapes: TopologyShape[] = ['mobius', 'klein', 'projective', 'trefoil'];
function sceneFor(shape: TopologyShape, radius = 14): SceneDefinition {
	const scene = createDefaultScene();
	scene.world = { kind: 'surface', shape, radius };
	return scene;
}

function expectPhysicalAtlas(scene: SceneDefinition) {
	if (!isTopologyWorld(scene.world)) throw new Error('Expected a topology world.');
	const mesh = createTopologyMesh(
		scene.world.shape,
		scene.world.radius,
		undefined,
		scene.world.shape === 'trefoil' ? trefoilTubeRatio(scene.world) : undefined
	);
	const rows =
		scene.world.shape === 'projective'
			? createTopologyRelations(mesh, worldInteractionLimit(scene.world)).rows
			: mesh.triangles.map(() => []);
	const data = packTopology(scene);
	const physicalRadius = scene.world.radius;
	const base = 1 + mesh.triangles.length * 8;
	let start = 0,
		maxError = 0,
		incorrectMetadata = 0;
	// Compare every geometric value against independently generated physical
	// geometry. Comparing routes also catches scale-sensitive shortest-path ties.
	const numeric = (offset: number, values: readonly number[]) => {
		values.forEach((value, index) => {
			maxError = Math.max(
				maxError,
				Math.abs(data[offset + index] - value) / Math.max(1, Math.abs(value))
			);
		});
	};
	const exact = (offset: number, values: readonly number[]) => {
		values.forEach((value, index) => {
			if (data[offset + index] !== value) incorrectMetadata++;
		});
	};
	mesh.triangles.forEach((face, index) => {
		const at = (1 + index * 8) * 4;
		face.forEach((vertex, edge) => {
			numeric(at + edge * 4, mesh.vertices[vertex]);
			exact(at + edge * 4 + 3, [mesh.neighbors[index][edge]]);
		});
		numeric(at + 12, [...mesh.normals[index], mesh.areas[index]]);
		exact(at + 16, [...mesh.edgeParity[index], 0]);
		exact(at + 20, [...mesh.neighborEdges[index], 0]);
		exact(at + 24, [start, rows[index].length]);
		numeric(at + 26, mesh.charts[index][2]);
		numeric(at + 28, [...mesh.charts[index][0], ...mesh.charts[index][1]]);
		for (const relation of rows[index]) {
			const offset = (base + start * 5) * 4;
			exact(offset, [relation.target]);
			numeric(offset + 1, [relation.cost]);
			exact(offset + 2, [0, 0]);
			relation.rotation.forEach((column, c) => {
				numeric(offset + (c + 1) * 4, column);
				exact(offset + (c + 1) * 4 + 3, [0]);
			});
			numeric(offset + 16, relation.translation);
			exact(offset + 19, [0]);
			start++;
		}
	});
	const smooth =
		scene.world.shape === 'projective'
			? packTopologyDisplayNormals(mesh)
			: packSmoothTopologyField(
					scene.world.shape,
					scene.world.shape === 'trefoil' ? trefoilTubeRatio(scene.world) : undefined
				);
	const smoothBase = base + start * 5;
	if (smooth.length) {
		exact(smoothBase * 4, Array.from(smooth.subarray(0, 4)));
		for (let row = 1; row < smooth.length / 4; row++)
			numeric(
				(smoothBase + row) * 4,
				Array.from(
					smooth.subarray(row * 4, row * 4 + 4),
					(value, component) =>
						value *
						(component < 3 && scene.world.shape !== 'projective' && row < smooth[3]
							? physicalRadius
							: 1)
				)
			);
	}
	expect(incorrectMetadata).toBe(0);
	expect(maxError).toBeLessThan(3e-7);
	expect(data.length).toBe(smoothBase * 4 + smooth.length);
	expect(Array.from(data.subarray(0, 4))).toEqual([
		mesh.triangles.length,
		8,
		16 + base,
		smooth.length ? 16 + smoothBase : 0
	]);
}

describe('scaled immutable topology atlases', () => {
	it.each(['mobius', 'klein', 'trefoil'] as const)(
		'covers every %s face with sparse intrinsic guide families at any mesh resolution',
		(shape) => {
			const counts = topologyGridCounts(shape);
			for (const resolution of [8, 24, 64]) {
				const mesh = createTopologyMesh(shape, 14, resolution);
				for (const chart of mesh.charts) {
					for (let axis = 0; axis < 2; axis++) {
						const coordinates = chart.map((point) => point[axis]),
							low = Math.min(...coordinates),
							high = Math.max(...coordinates);
						const crossed =
							Math.floor((high + 1e-7) * counts[axis]) - Math.floor((low + 1e-7) * counts[axis]);
						expect(crossed).toBeLessThanOrEqual(3);
					}
				}
			}
		}
	);

	it.each(shapes)('matches direct physical %s geometry and unfolding routes', (shape) => {
		expectPhysicalAtlas(sceneFor(shape));
	});
	it.each([0.06, 0.16])(
		'packs actual Trefoil thickness %s and its independently unfolded routes',
		(ratio) => {
			const scene = sceneFor('trefoil');
			scene.world = { kind: 'surface', shape: 'trefoil', radius: 14, tubeRadius: 14 * ratio };
			expectPhysicalAtlas(scene);
		}
	);
	it('rebuilds distinct thicknesses, reuses uniform scale, and evicts slider geometries', () => {
		const actualFactory = meshModule.createTopologyMesh;
		// This gate checks bounded caching and parameter keys. Full-resolution
		// geometry/route parity is covered above; six cold atlases add no coverage.
		const factory = vi
			.spyOn(meshModule, 'createTopologyMesh')
			.mockImplementation((shape, radius, _resolution, ratio) =>
				actualFactory(shape, radius, 8, ratio)
			);
		try {
			const scene = sceneFor('trefoil');
			const ratios = [0.041, 0.052, 0.063, 0.074, 0.085];
			for (const ratio of ratios) {
				scene.world = { kind: 'surface', shape: 'trefoil', radius: 16, tubeRadius: 16 * ratio };
				packTopology(scene);
			}
			expect(factory).toHaveBeenCalledTimes(5);
			const recent = packTopology(scene);
			scene.world = { kind: 'surface', shape: 'trefoil', radius: 32, tubeRadius: 32 * ratios[4] };
			const scaled = packTopology(scene);
			expect(factory).toHaveBeenCalledTimes(5);
			expect(scaled[4]).toBeCloseTo(recent[4] * 2, 5);
			scene.world = { kind: 'surface', shape: 'trefoil', radius: 16, tubeRadius: 16 * ratios[0] };
			packTopology(scene);
			expect(factory).toHaveBeenCalledTimes(6);
		} finally {
			factory.mockRestore();
		}
	});

	it.each(shapes)(
		'rebinds %s atlases behind 0, 1 and 32 obstacles without changing tick history',
		(shape) => {
			const mesh = createTopologyMesh(shape, 14);
			const center = mesh.triangles[0]
				.map((vertex) => mesh.vertices[vertex])
				.reduce((a, b) => [a[0] + b[0] / 3, a[1] + b[1] / 3, a[2] + b[2] / 3], [0, 0, 0]);
			for (const obstacles of [0, 1, 32]) {
				const scene = sceneFor(shape);
				scene.obstacles = Array.from({ length: obstacles }, (_, i) => ({
					id: `obstacle-${i}`,
					shape: 'sphere',
					center,
					radius: 0.1,
					triangle: 0
				}));
				const prefix = (16 + obstacles * 2) * 4;
				const config = packConfig(scene, {
					population: 20,
					tick: 0,
					historyHead: 0,
					validHistory: 1
				});
				const base = 1 + mesh.triangles.length * 8;
				expect(config[prefix + 2]).toBe(prefix / 4 + base);
				expect(config[9 * 4 + 1]).toBe(obstacles);
				const atlasBytes = new Uint8Array(config.buffer.slice(prefix * 4));
				const returned = packConfig(
					scene,
					{
						population: 20,
						tick: 0x1000007,
						historyHead: 12,
						validHistory: 9,
						field: { position: center, active: true, pressed: true, triangle: 0 },
						selectedId: 0xfffffffd
					},
					undefined,
					config.subarray(0, prefix)
				);
				expect(returned.buffer).toBe(config.buffer);
				expect(config[10 * 4 + 1]).toBe(12);
				const after = new Uint8Array(config.buffer, prefix * 4);
				expect(after.every((value, i) => value === atlasBytes[i])).toBe(true);
				const words = new Uint32Array(config.buffer);
				expect(words[14 * 4]).toBe(0x1000007);
				expect(words[14 * 4 + 3]).toBe(0xfffffffd);
			}
		}
	);

	it('keeps cached coordinates, area and transforms independent of callers and radius', () => {
		const scene = sceneFor('mobius', 7);
		const original = packTopology(scene);
		const preserved = original.slice();
		original.fill(NaN);
		const repeated = packTopology(scene);
		expect(repeated.every((value, i) => value === preserved[i])).toBe(true);
		const larger = packTopology(sceneFor('mobius', 21));
		const faces = repeated[0],
			base = 1 + faces * 8,
			smoothBase = repeated[3] - 16,
			normalBase = smoothBase + repeated[smoothBase * 4 + 3];
		let maxError = 0,
			metadataChanges = 0;
		for (let row = 0; row < repeated.length / 4; row++) {
			for (let component = 0; component < 4; component++) {
				let factor = 1;
				if (row > 0 && row < base) {
					const relativeRow = (row - 1) % 8;
					if (relativeRow < 3 && component < 3) factor = 3;
					if (relativeRow === 3 && component === 3) factor = 9;
				} else if (row > smoothBase && row < normalBase) {
					if (component < 3) factor = 3;
				} else if (row >= base && row < smoothBase) {
					const relativeRow = (row - base) % 5;
					if ((relativeRow === 0 && component === 1) || (relativeRow === 4 && component < 3))
						factor = 3;
				}
				const at = row * 4 + component;
				if (factor === 1 && larger[at] !== repeated[at]) metadataChanges++;
				const expected = repeated[at] * factor;
				maxError = Math.max(
					maxError,
					Math.abs(larger[at] - expected) / Math.max(1, Math.abs(expected))
				);
			}
		}
		expect(metadataChanges).toBe(0);
		expect(maxError).toBeLessThan(2e-7);
	});

	it('allocates no topology atlas for regular worlds and rejects invalid topology radii', () => {
		expect(packTopology(createDefaultScene()).length).toBe(0);
		expect(() => packTopology(sceneFor('mobius', NaN))).toThrow('Invalid topology radius');
	});
});
