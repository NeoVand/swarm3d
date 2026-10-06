import { isTopologyWorld, trefoilTubeRatio, worldInteractionLimit } from '#lib/model';
import { createTopologyMesh } from '#lib/model/topology-mesh';
import { createTopologyRelations } from '#lib/model/topology-relations';
import { packSmoothTopologyField } from '#lib/model/topology-smooth';
import { packTopologyDisplayNormals } from './topology-display-normals';
import type { SceneDefinition, TopologyShape, WorldDefinition } from '#lib/model';

const FACE_ROWS = 8;
const RELATION_ROWS = 5;
interface UnitAtlas {
	data: Float32Array<ArrayBuffer>;
	faces: number;
	pairs: number;
	base: number;
	smoothBase: number;
}
// Keep four recently used geometries, including distinct Trefoil thicknesses.
// Uniform scale edits only copy packed data; thickness edits rebuild the smooth field.
const unitAtlases = new Map<string, UnitAtlas>();

function unitAtlas(shape: TopologyShape, tubeRatio?: number): UnitAtlas {
	const key = `${shape}:${tubeRatio ?? ''}`;
	const cached = unitAtlases.get(key);
	if (cached) {
		unitAtlases.delete(key);
		unitAtlases.set(key, cached);
		return cached;
	}
	const mesh = createTopologyMesh(shape, 1, undefined, tubeRatio);
	// Smooth chart worlds no longer use face-to-face routing. Avoid building a
	// quadratic-ish cold route atlas for every tube thickness while dragging.
	const rows =
		shape === 'projective'
			? createTopologyRelations(mesh, worldInteractionLimit({ kind: 'surface', shape, radius: 1 }))
					.rows
			: mesh.triangles.map(() => []);
	const faces = mesh.triangles.length;
	const pairs = rows.reduce((sum, list) => sum + list.length, 0);
	const base = 1 + faces * FACE_ROWS;
	const smoothField =
		shape === 'projective'
			? packTopologyDisplayNormals(mesh)
			: packSmoothTopologyField(shape, tubeRatio);
	const smoothBase = smoothField.length ? base + pairs * RELATION_ROWS : 0;
	const data = new Float32Array((base + pairs * RELATION_ROWS) * 4 + smoothField.length);
	const row = (index: number, value: readonly number[]) => data.set(value, index * 4);
	row(0, [faces, FACE_ROWS, base, smoothBase]);
	if (smoothBase) data.set(smoothField, smoothBase * 4);
	let start = 0;
	mesh.triangles.forEach((face, index) => {
		const at = 1 + index * FACE_ROWS;
		face.forEach((vertex, edge) =>
			row(at + edge, [...mesh.vertices[vertex], mesh.neighbors[index][edge]])
		);
		row(at + 3, [...mesh.normals[index], mesh.areas[index]]);
		row(at + 4, [...mesh.edgeParity[index], 0]);
		row(at + 5, [...mesh.neighborEdges[index], 0]);
		const chart = mesh.charts[index];
		row(at + 6, [start, rows[index].length, ...chart[2]]);
		row(at + 7, [...chart[0], ...chart[1]]);
		for (const relation of rows[index]) {
			const at = base + start * RELATION_ROWS;
			row(at, [relation.target, relation.cost, 0, 0]);
			relation.rotation.forEach((column, c) => row(at + c + 1, [...column, 0]));
			row(at + 4, [...relation.translation, 0]);
			start++;
		}
	});
	const result = { data, faces, pairs, base, smoothBase };
	if (unitAtlases.size >= 4) unitAtlases.delete(unitAtlases.keys().next().value!);
	unitAtlases.set(key, result);
	return result;
}

/** Static topology atlas appended to the existing configuration binding. The
 * hot tick uploads only the small dynamic prefix, not this immutable atlas.
 * Each caller owns its scaled copy, so replacement buffers cannot mutate the
 * normalized atlas retained for subsequent radius edits. */
export function packTopology(scene: SceneDefinition) {
	return packTopologyWorld(scene.world, scene.obstacles.length);
}

/** Pure geometry request used in the browser worker without application state. */
export function packTopologyWorld(world: WorldDefinition, obstacleCount: number) {
	if (!isTopologyWorld(world)) return new Float32Array(0);
	const radius = world.radius;
	if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Invalid topology radius.');
	const atlas = unitAtlas(
		world.shape,
		world.shape === 'trefoil' ? trefoilTubeRatio(world) : undefined
	);
	const data = atlas.data.slice();
	data[2] = 16 + obstacleCount * 2 + atlas.base;
	data[3] = atlas.smoothBase ? 16 + obstacleCount * 2 + atlas.smoothBase : 0;
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
	// Polynomial position coefficients carry physical world units. The appended
	// display-normal lattice and chart header remain dimensionless.
	if (atlas.smoothBase && world.shape !== 'projective') {
		const normalBase = atlas.smoothBase + data[atlas.smoothBase * 4 + 3];
		for (let row = atlas.smoothBase + 1; row < normalBase; row++) {
			const at = row * 4;
			data[at] *= radius;
			data[at + 1] *= radius;
			data[at + 2] *= radius;
		}
	}
	return data;
}
