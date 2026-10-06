import type { TopologyMesh } from '#lib/model/topology-mesh';
import type { Vec3 } from '#lib/model/types';

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
	dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
	magnitude = (a: Vec3) => Math.hypot(...a);

/** Presentation normals on the orientation cover of each vertex's local fan.
 * Vertex IDs preserve immersion sheets. Parity transport avoids averaging
 * opposite local orientations across a nonorientable seam. Physics continues
 * to use the explicit polyhedral metric and its exact face normals. */
export function packTopologyDisplayNormals(mesh: TopologyMesh): Float32Array<ArrayBuffer> {
	const data = new Float32Array(4 + mesh.triangles.length * 12);
	data.set([0, 0, 3, 0]);
	mesh.triangles.forEach((triangle, face) => {
		triangle.forEach((vertex, corner) => {
			const seen = new Set<number>(),
				queue = [{ face, parity: 1 }];
			let normal: Vec3 = [0, 0, 0];
			for (let head = 0; head < queue.length; head++) {
				const current = queue[head];
				if (seen.has(current.face)) continue;
				seen.add(current.face);
				const faceVertices = mesh.triangles[current.face],
					local = faceVertices.indexOf(vertex);
				if (local < 0) continue;
				const a = subtract(mesh.vertices[faceVertices[(local + 1) % 3]], mesh.vertices[vertex]),
					b = subtract(mesh.vertices[faceVertices[(local + 2) % 3]], mesh.vertices[vertex]),
					angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (magnitude(a) * magnitude(b))))),
					weight = angle * mesh.areas[current.face] * current.parity;
				normal = normal.map(
					(value, axis) => value + mesh.normals[current.face][axis] * weight
				) as unknown as Vec3;
				for (let edge = 0; edge < 3; edge++) {
					if (edge === local) continue;
					const neighbor = mesh.neighbors[current.face][edge];
					if (neighbor >= 0 && !seen.has(neighbor))
						queue.push({
							face: neighbor,
							parity: current.parity * mesh.edgeParity[current.face][edge]
						});
				}
			}
			const length = magnitude(normal);
			data.set(
				length > 1e-12 ? normal.map((value) => value / length) : mesh.normals[face],
				4 + face * 12 + corner * 4
			);
		});
	});
	return data;
}
