import type { Vec3 } from './types';
import type { TopologyMesh } from './topology-mesh';

type Rotation = readonly [Vec3, Vec3, Vec3];
export interface FaceRelation {
	target: number;
	cost: number;
	rotation: Rotation;
	translation: Vec3;
}
export interface TopologyRelations {
	mesh: TopologyMesh;
	rows: FaceRelation[][];
	range: number;
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];
const norm = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3) => mul(a, 1 / Math.max(norm(a), 1e-15));
const identity: Rotation = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1]
];
export const rotateTopologyVector = (r: Rotation, v: Vec3): Vec3 =>
	[0, 1, 2].map((i) => r[0][i] * v[0] + r[1][i] * v[1] + r[2][i] * v[2]) as unknown as Vec3;
const compose = (a: Rotation, b: Rotation): Rotation =>
	b.map((v) => rotateTopologyVector(a, v)) as unknown as Rotation;

/** Rigid edge unfolding. Neighbor interior lands opposite the source interior;
 * this stays defined when the two triangle winding conventions disagree. */
export function unfoldTopologyEdge(mesh: TopologyMesh, face: number, edge: number) {
	const neighbor = mesh.neighbors[face][edge],
		opposite = mesh.neighborEdges[face][edge];
	if (neighbor < 0) throw new RangeError('A physical boundary has no neighboring face.');
	const indices = mesh.triangles[face],
		a = mesh.vertices[indices[(edge + 1) % 3]],
		b = mesh.vertices[indices[(edge + 2) % 3]];
	const axis = unit(sub(b, a));
	const tangent = (point: Vec3) => unit(sub(sub(point, a), mul(axis, dot(sub(point, a), axis))));
	const source = mul(tangent(mesh.vertices[indices[edge]]), -1),
		target = tangent(mesh.vertices[mesh.triangles[neighbor][opposite]]);
	const sourceNormal = cross(axis, source),
		targetNormal = cross(axis, target);
	const rotation = [0, 1, 2].map((i) =>
		add(mul(axis, axis[i]), add(mul(source, target[i]), mul(sourceNormal, targetNormal[i])))
	) as unknown as Rotation;
	return { rotation, translation: sub(a, rotateTopologyVector(rotation, a)) };
}

type HeapEntry = readonly [number, number];
const earlier = (a: HeapEntry, b: HeapEntry) => a[1] < b[1] || (a[1] === b[1] && a[0] < b[0]);
class Heap {
	items: HeapEntry[] = [];
	push(face: number, cost: number) {
		const a = this.items,
			entry: HeapEntry = [face, cost];
		let i = a.length;
		a.push(entry);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!earlier(entry, a[p])) break;
			a[i] = a[p];
			i = p;
		}
		a[i] = entry;
	}
	pop() {
		const a = this.items,
			result = a[0],
			last = a.pop()!;
		if (a.length) {
			let i = 0;
			while (i * 2 + 1 < a.length) {
				let c = i * 2 + 1;
				if (c + 1 < a.length && earlier(a[c + 1], a[c])) c++;
				if (!earlier(a[c], last)) break;
				a[i] = a[c];
				i = c;
			}
			a[i] = last;
		}
		return result;
	}
}
/** Canonical routing precision in normalized world units, below GPU float error. */
export const TOPOLOGY_PATH_PRECISION = 1e9;

const tables = new WeakMap<TopologyMesh, TopologyRelations>();
/** Local polyhedral approximation: unfold a shortest centroid path. This is
 * deliberately distinct from an exact smooth-surface logarithm. Every face
 * in the declared local graph envelope is retained, including crowded faces.
 * Integer normalized edge costs and deterministic face-ID ties choose the same
 * corridor at every scene scale. Stored physical costs use those same integers;
 * classifier distances therefore agree with the reusable normalized GPU atlas.
 */
export function createTopologyRelations(mesh: TopologyMesh, range: number): TopologyRelations {
	const cached = tables.get(mesh);
	if (cached && cached.range >= range) return cached;
	const count = mesh.triangles.length;
	const worldScale = Math.max(...mesh.bounds);
	if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(worldScale) || worldScale <= 0)
		throw new RangeError('Topology relation range and world scale must be positive and finite.');
	const precision = TOPOLOGY_PATH_PRECISION;

	const centers = mesh.triangles.map((face) =>
		mul(face.map((v) => mesh.vertices[v]).reduce(add), 1 / 3)
	);
	const radius = Math.max(
		...mesh.triangles.map((face, i) =>
			Math.max(...face.map((v) => norm(sub(mesh.vertices[v], centers[i]))))
		)
	);
	// The declared corridor floor rejects pairs beyond this envelope. Retaining
	// every face inside it is complete for this classifier, with no fixed cap.
	const envelope = Math.round(((range + radius * 2) / worldScale) * precision);
	const edges = mesh.neighbors.map((neighbors, face) =>
		neighbors.map((n, e) =>
			n < 0
				? null
				: {
						...unfoldTopologyEdge(mesh, face, e),
						cost: Math.max(
							1,
							Math.round((norm(sub(centers[n], centers[face])) / worldScale) * precision)
						)
					}
		)
	);
	const rows: FaceRelation[][] = [];
	for (let origin = 0; origin < count; origin++) {
		const costs = new Float64Array(count).fill(Infinity),
			heap = new Heap();
		const transforms = new Map<number, FaceRelation>();
		costs[origin] = 0;
		heap.push(origin, 0);
		transforms.set(origin, { target: origin, cost: 0, rotation: identity, translation: [0, 0, 0] });
		while (heap.items.length) {
			const [face, cost] = heap.pop();
			if (cost !== costs[face]) continue;
			const current = transforms.get(face)!;
			mesh.neighbors[face].forEach((target, e) => {
				const edge = edges[face][e];
				if (!edge) return;
				const next = cost + edge.cost;
				if (next > envelope || next >= costs[target]) return;
				costs[target] = next;
				transforms.set(target, {
					target,
					cost: (next * worldScale) / precision,
					rotation: compose(current.rotation, edge.rotation),
					translation: add(
						rotateTopologyVector(current.rotation, edge.translation),
						current.translation
					)
				});
				heap.push(target, next);
			});
		}
		rows.push([...transforms.values()].sort((a, b) => a.target - b.target));
	}
	const result = { mesh, rows, range };
	tables.set(mesh, result);
	return result;
}
export function topologyRelation(
	table: TopologyRelations,
	fromFace: number,
	toFace: number,
	from: Vec3,
	to: Vec3,
	velocity: Vec3 = [0, 0, 0]
) {
	const transform = table.rows[fromFace]?.find((entry) => entry.target === toFace);
	if (!transform) return undefined;
	const displacement = sub(
		add(rotateTopologyVector(transform.rotation, to), transform.translation),
		from
	);
	const center = (face: number) =>
		mul(table.mesh.triangles[face].map((v) => table.mesh.vertices[v]).reduce(add), 1 / 3);
	const pathFloor =
		transform.cost - norm(sub(from, center(fromFace))) - norm(sub(to, center(toFace)));
	return {
		displacement,
		distance: Math.max(norm(displacement), norm(sub(to, from)), pathFloor),
		velocity: rotateTopologyVector(transform.rotation, velocity)
	};
}
