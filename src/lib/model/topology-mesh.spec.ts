import { describe, expect, it } from 'vitest';
import type { TopologyShape, Vec3 } from '#lib/model/types';
import {
	createTopologyMesh,
	sampleTopology,
	topologyBarycentric,
	topologyEdgeTransport,
	topologyPoint,
	walkTopology
} from '#lib/model/topology-mesh';
import type { TopologyMesh } from '#lib/model/topology-mesh';

const shapes: TopologyShape[] = ['mobius', 'klein', 'projective', 'genus2'];
const length = (v: Vec3) => Math.hypot(...v);
const dot = (a: Vec3, b: Vec3) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, t: number): Vec3 => [a[0] * t, a[1] * t, a[2] * t];
const meshes = new Map<TopologyShape, TopologyMesh>();
const mesh = (shape: TopologyShape) => {
	let value = meshes.get(shape);
	if (!value) {
		value = createTopologyMesh(shape, 14);
		meshes.set(shape, value);
	}
	return value;
};
function topology(m: TopologyMesh) {
	const edges = new Set<string>();
	const boundary = new Map<number, Set<number>>();
	m.triangles.forEach((face, index) =>
		face.forEach((_, e) => {
			const a = face[(e + 1) % 3],
				b = face[(e + 2) % 3];
			edges.add(`${Math.min(a, b)},${Math.max(a, b)}`);
			if (m.neighbors[index][e] === -1) {
				for (const [from, to] of [
					[a, b],
					[b, a]
				]) {
					const adjacent = boundary.get(from) ?? new Set();
					adjacent.add(to);
					boundary.set(from, adjacent);
				}
			}
		})
	);
	const visited = new Set<number>();
	let boundaries = 0;
	for (const start of boundary.keys()) {
		if (visited.has(start)) continue;
		boundaries++;
		const stack = [start];
		while (stack.length) {
			const at = stack.pop()!;
			if (visited.has(at)) continue;
			visited.add(at);
			stack.push(...boundary.get(at)!);
		}
	}
	const orientation = new Map<number, number>([[0, 1]]),
		stack = [0];
	let orientable = true;
	while (stack.length) {
		const at = stack.pop()!;
		for (let e = 0; e < 3; e++) {
			const next = m.neighbors[at][e];
			if (next < 0) continue;
			const sign = orientation.get(at)! * m.edgeParity[at][e],
				prior = orientation.get(next);
			if (prior === undefined) {
				orientation.set(next, sign);
				stack.push(next);
			} else if (prior !== sign) orientable = false;
		}
	}
	return {
		euler: m.vertices.length - edges.size + m.triangles.length,
		boundaries,
		orientable,
		connected: orientation.size === m.triangles.length
	};
}
describe('topology-preserving piecewise-flat worlds', () => {
	it.each(shapes)(
		'has the expected topology and nondegenerate complete adjacency for %s',
		(shape) => {
			const m = mesh(shape),
				actual = topology(m);
			expect(actual).toEqual({
				euler: shape === 'projective' ? 1 : shape === 'genus2' ? -2 : 0,
				boundaries: shape === 'mobius' ? 1 : 0,
				orientable: shape === 'genus2',
				connected: true
			});
			expect(m.areas.every((area) => area > 0 && Number.isFinite(area))).toBe(true);
			expect(m.area).toBeGreaterThan(1);
			for (let i = 0; i < m.triangles.length; i++)
				for (let e = 0; e < 3; e++) {
					const next = m.neighbors[i][e];
					if (next < 0) continue;
					const edge = m.neighborEdges[i][e];
					expect(m.neighbors[next][edge]).toBe(i);
					expect(m.neighborEdges[next][edge]).toBe(e);
					expect(m.edgeParity[next][edge]).toBe(m.edgeParity[i][e]);
				}
		}
	);
	it.each(shapes)('preserves tangent length through edge transport and walking for %s', (shape) => {
		const m = mesh(shape);
		for (
			let index = 0;
			index < m.triangles.length;
			index += Math.max(1, Math.floor(m.triangles.length / 30))
		) {
			const face = m.triangles[index],
				velocity = scale(sub(m.vertices[face[1]], m.vertices[face[0]]), 0.35);
			for (let edge = 0; edge < 3; edge++) {
				const next = m.neighbors[index][edge];
				if (next < 0) continue;
				const transported = topologyEdgeTransport(m, index, edge, velocity);
				expect(length(transported)).toBeCloseTo(length(velocity), 9);
				expect(dot(transported, m.normals[next])).toBeCloseTo(0, 9);
				const back = topologyEdgeTransport(
					m,
					next,
					m.neighborEdges[index][edge],
					transported,
					m.edgeParity[index][edge] as 1 | -1
				);
				expect(length(sub(back, velocity))).toBeLessThan(1e-9);
			}
			const result = walkTopology(
				m,
				{ triangle: index, barycentric: [1 / 3, 1 / 3, 1 / 3] },
				velocity,
				velocity
			);
			expect(result.complete).toBe(true);
			expect(result.barycentric.every((v) => v >= -1e-9)).toBe(true);
			expect(length(result.velocity)).toBeCloseTo(length(velocity), 8);
			expect(dot(result.velocity, m.normals[result.triangle])).toBeCloseTo(0, 8);
		}
	});
	it.each(shapes)(
		'samples actual triangle area and keeps barycentric identities for %s',
		(shape) => {
			const m = mesh(shape);
			let seed = 455;
			const random = () => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				return seed / 2 ** 32;
			};
			for (let i = 0; i < 100; i++) {
				const sample = sampleTopology(m, random),
					weights = topologyBarycentric(m, sample.triangle, sample.position);
				expect(length(sub(weights, sample.barycentric))).toBeLessThan(1e-9);
				expect(
					length(sub(topologyPoint(m, sample.triangle, sample.barycentric), sample.position))
				).toBe(0);
			}
		}
	);
	it.each(['mobius', 'klein', 'projective'] as const)(
		'crosses a reversing %s chart seam without a velocity jump',
		(shape) => {
			const m = mesh(shape);
			const triangle = m.edgeParity.findIndex((row) => row.includes(-1));
			const edge = m.edgeParity[triangle].indexOf(-1);
			const f = m.triangles[triangle];
			const midpoint = scale(
				[
					m.vertices[f[(edge + 1) % 3]][0] + m.vertices[f[(edge + 2) % 3]][0],
					m.vertices[f[(edge + 1) % 3]][1] + m.vertices[f[(edge + 2) % 3]][1],
					m.vertices[f[(edge + 1) % 3]][2] + m.vertices[f[(edge + 2) % 3]][2]
				],
				0.5
			);
			const center = topologyPoint(m, triangle, [1 / 3, 1 / 3, 1 / 3]);
			const motion = scale(sub(midpoint, center), 1.1);
			const result = walkTopology(m, { triangle, barycentric: [1 / 3, 1 / 3, 1 / 3] }, motion);
			expect(result.complete).toBe(true);
			expect(result.triangle).toBe(m.neighbors[triangle][edge]);
			expect(result.orientation).toBe(-1);
			expect(length(result.velocity)).toBeCloseTo(length(motion), 9);
		}
	);
	it('reflects at the single physical Möbius edge and keeps the tangent speed', () => {
		const m = mesh('mobius'),
			triangle = m.neighbors.findIndex((row) => row.includes(-1));
		const edge = m.neighbors[triangle].indexOf(-1),
			weights = [0.5, 0.5, 0.5];
		weights[edge] = 0;
		const midpoint = topologyPoint(m, triangle, weights as unknown as Vec3);
		const center = topologyPoint(m, triangle, [1 / 3, 1 / 3, 1 / 3]);
		const motion = scale(sub(midpoint, center), 1.25);
		const result = walkTopology(m, { triangle, barycentric: [1 / 3, 1 / 3, 1 / 3] }, motion);
		expect(result.complete).toBe(true);
		expect(result.orientation).toBe(1);
		expect(result.barycentric.every((value) => value >= 0)).toBe(true);
		expect(length(result.velocity)).toBeCloseTo(length(motion), 9);
		expect(dot(result.velocity, sub(midpoint, center))).toBeLessThan(0);
	});
	it.each(['klein', 'projective'] as const)(
		'retains separate %s sheets at coincident world points',
		(shape) => {
			const m = mesh(shape),
				positions = new Map<string, number[]>();
			m.vertices.forEach((p, id) => {
				const key = p.map((value) => value.toFixed(8)).join(',');
				const group = positions.get(key) ?? [];
				group.push(id);
				positions.set(key, group);
			});
			const coincident = [...positions.values()].find((ids) => ids.length > 1);
			expect(coincident).toBeDefined();
			for (let i = 1; i < coincident!.length; i++) {
				expect(length(sub(m.vertices[coincident![0]], m.vertices[coincident![i]]))).toBeLessThan(
					1e-7
				);
				expect(
					m.triangles.some((face) => face.includes(coincident![0]) && face.includes(coincident![i]))
				).toBe(false);
			}
		}
	);
	it.each(shapes)('keeps topology valid for coarse and finer %s tessellations', (shape) => {
		for (const resolution of [12, 32]) {
			const m = createTopologyMesh(shape, 14, resolution);
			expect(topology(m)).toEqual({
				euler: shape === 'projective' ? 1 : shape === 'genus2' ? -2 : 0,
				boundaries: shape === 'mobius' ? 1 : 0,
				orientable: shape === 'genus2',
				connected: true
			});
		}
	});

	it('scales area, geometry and sampling coherently and rejects invalid dimensions', () => {
		const a = createTopologyMesh('mobius', 7),
			b = mesh('mobius');
		expect(b.area / a.area).toBeCloseTo(4, 10);
		expect(() => createTopologyMesh('klein', 0)).toThrow();
		expect(() => createTopologyMesh('genus2', 14, 5)).toThrow();
	});
});
