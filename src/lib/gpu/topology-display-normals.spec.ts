import { describe, expect, it } from 'vitest';
import { createTopologyMesh } from '#lib/model/topology-mesh';
import { packTopologyDisplayNormals } from './topology-display-normals';

describe('presentation normals on the topology orientation cover', () => {
	it.each(['projective', 'mobius', 'klein'] as const)(
		'keeps %s shared-vertex normals consistent through reflected seams',
		(shape) => {
			const mesh = createTopologyMesh(shape, 14),
				field = packTopologyDisplayNormals(mesh);
			let maximumError = 0,
				reflected = 0;
			mesh.triangles.forEach((triangle, face) => {
				triangle.forEach((_vertex, corner) => {
					const at = 4 + face * 12 + corner * 4;
					expect(Math.hypot(field[at], field[at + 1], field[at + 2])).toBeCloseTo(1, 6);
				});
				for (let edge = 0; edge < 3; edge++) {
					const neighbor = mesh.neighbors[face][edge],
						parity = mesh.edgeParity[face][edge];
					if (neighbor < 0) continue;
					if (parity < 0) reflected++;
					for (const corner of [(edge + 1) % 3, (edge + 2) % 3]) {
						const otherCorner = mesh.triangles[neighbor].indexOf(triangle[corner]);
						for (let axis = 0; axis < 3; axis++)
							maximumError = Math.max(
								maximumError,
								Math.abs(
									field[4 + face * 12 + corner * 4 + axis] -
										parity * field[4 + neighbor * 12 + otherCorner * 4 + axis]
								)
							);
					}
				}
			});
			expect(reflected).toBeGreaterThan(0);
			expect(maximumError).toBeLessThan(1e-6);
		}
	);
	it('keeps display normals unitless when the world radius changes', () => {
		const small = packTopologyDisplayNormals(createTopologyMesh('projective', 7)),
			large = packTopologyDisplayNormals(createTopologyMesh('projective', 35));
		expect(Array.from(small.subarray(0, 4))).toEqual([0, 0, 3, 0]);
		let maximumError = 0;
		small.forEach((value, i) => {
			maximumError = Math.max(maximumError, Math.abs(value - large[i]));
		});
		expect(maximumError).toBeLessThan(1e-6);
	});
});
