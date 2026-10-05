import { isTopologyWorld, worldInteractionLimit } from '#lib/model';
import { createTopologyMesh } from '#lib/model/topology-mesh';
import { createTopologyRelations } from '#lib/model/topology-relations';
import type { SceneDefinition, TopologyShape } from '#lib/model';

const FACE_ROWS = 8;
const RELATION_ROWS = 5;
interface UnitAtlas {
	data: Float32Array<ArrayBuffer>;
	faces: number;
	pairs: number;
	base: number;
}
// Four shapes, at most one atlas each. Radius edits only copy and scale the
// packed data; they never rebuild hundreds of thousands of graph routes.
const unitAtlases = new Map<TopologyShape, UnitAtlas>();

function unitAtlas(shape: TopologyShape): UnitAtlas {
	const cached = unitAtlases.get(shape);
	if (cached) return cached;
	const mesh = createTopologyMesh(shape, 1);
	const table = createTopologyRelations(
		mesh,
		worldInteractionLimit({ kind: 'surface', shape, radius: 1 })
	);
	const faces = mesh.triangles.length;
	const pairs = table.rows.reduce((sum, list) => sum + list.length, 0);
	const data = new Float32Array((1 + faces * FACE_ROWS + pairs * RELATION_ROWS) * 4);
	const row = (index: number, value: readonly number[]) => data.set(value, index * 4);
	const base = 1 + faces * FACE_ROWS;
	row(0, [faces, FACE_ROWS, base, RELATION_ROWS]);
	let start = 0;
	mesh.triangles.forEach((face, index) => {
		const at = 1 + index * FACE_ROWS;
		face.forEach((vertex, edge) =>
			row(at + edge, [...mesh.vertices[vertex], mesh.neighbors[index][edge]])
		);
		row(at + 3, [...mesh.normals[index], mesh.areas[index]]);
		row(at + 4, [...mesh.edgeParity[index], 0]);
		row(at + 5, [...mesh.neighborEdges[index], 0]);
		row(at + 6, [start, table.rows[index].length, 0, 0]);
		for (const relation of table.rows[index]) {
			const at = base + start * RELATION_ROWS;
			row(at, [relation.target, relation.cost, 0, 0]);
			relation.rotation.forEach((column, c) => row(at + c + 1, [...column, 0]));
			row(at + 4, [...relation.translation, 0]);
			start++;
		}
	});
	const result = { data, faces, pairs, base };
	if (unitAtlases.size >= 4) unitAtlases.delete(unitAtlases.keys().next().value!);
	unitAtlases.set(shape, result);
	return result;
}

/** Static topology atlas appended to the existing configuration binding. The
 * hot tick uploads only the small dynamic prefix, not this immutable atlas.
 * Each caller owns its scaled copy, so replacement buffers cannot mutate the
 * normalized atlas retained for subsequent radius edits. */
export function packTopology(scene: SceneDefinition) {
	if (!isTopologyWorld(scene.world)) return new Float32Array(0);
	const radius = scene.world.radius;
	if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Invalid topology radius.');
	const atlas = unitAtlas(scene.world.shape);
	const data = atlas.data.slice();
	data[2] = 16 + scene.obstacles.length * 2 + atlas.base;
	const radiusSquared = radius * radius;
	for (let face = 0; face < atlas.faces; face++) {
		const at = (1 + face * FACE_ROWS) * 4;
		for (let vertex = 0; vertex < 3; vertex++) {
			const position = at + vertex * 4;
			data[position] *= radius;
			data[position + 1] *= radius;
			data[position + 2] *= radius;
		}
		data[at + 15] *= radiusSquared;
	}
	for (let pair = 0; pair < atlas.pairs; pair++) {
		const at = (atlas.base + pair * RELATION_ROWS) * 4;
		data[at + 1] *= radius;
		data[at + 16] *= radius;
		data[at + 17] *= radius;
		data[at + 18] *= radius;
	}
	return data;
}
