import { describe, expect, it } from 'vitest';
import type { TopologyShape, Vec3 } from '#lib/model/types';
import {
	createTopologyMesh,
	kleinBottlePoint,
	sampleTopology,
	topologyBarycentric,
	topologyEdgeTransport,
	topologyPoint,
	TREFOIL_DEFAULT_TUBE_RATIO,
	TREFOIL_MAX_TUBE_RATIO,
	TREFOIL_MIN_TUBE_RATIO,
	trefoilSurfacePoint,
	walkTopology
} from '#lib/model/topology-mesh';
import type { TopologyMesh } from '#lib/model/topology-mesh';
import { findSurfaceIntersections } from '../../../scripts/helpers/topology-fixtures';

const shapes: TopologyShape[] = ['mobius', 'klein', 'projective', 'trefoil'];
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
				euler: shape === 'projective' ? 1 : 0,
				boundaries: shape === 'mobius' ? 1 : 0,
				orientable: shape === 'trefoil',
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
	it.each(['projective'] as const)(
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
	it('matches the old upright Dickson bottle, including the quarter-turn transverse phase', () => {
		const landmarks: [number, number, Vec3][] = [
			[0, 0, [2, 8, 6]],
			[0, Math.PI / 2, [0, 8, 4]],
			[Math.PI / 2, 0, [4, -8, 0]],
			[Math.PI, 0, [6, 8, -6]],
			[(3 * Math.PI) / 2, 0, [4, 24, 0]]
		];
		for (const [u, v, expected] of landmarks)
			expect(length(sub(kleinBottlePoint(u, v), expected))).toBeLessThan(1e-12);
		const m = mesh('klein'),
			nu = 48,
			nv = 24,
			raw = Array.from({ length: nu * nv }, (_, i) =>
				kleinBottlePoint((2 * Math.PI * Math.floor(i / nv)) / nu, (2 * Math.PI * (i % nv)) / nv)
			),
			center = [0, 1, 2].map((axis) => {
				const values = raw.map((point) => point[axis]);
				return (Math.min(...values) + Math.max(...values)) / 2;
			}) as unknown as Vec3,
			centered = raw.map((point) => sub(point, center)),
			factor = 14 / Math.max(...centered.map(length));
		for (let i = 0; i < raw.length; i++)
			expect(length(sub(m.vertices[i], scale(centered[i], factor)))).toBeLessThan(1e-12);
		for (const axis of [0, 1, 2]) {
			const values = m.vertices.map((point) => point[axis]);
			expect(Math.min(...values) + Math.max(...values)).toBeCloseTo(0, 12);
		}
		expect(m.bounds[1]).toBeGreaterThan(1.4 * Math.max(m.bounds[0], m.bounds[2]));
	});
	it('closes the exact Dickson reversing seam and retains its continuous piecewise join', () => {
		for (const u of [-4.3, 0.37, Math.PI, 8.7])
			for (const v of [-2.9, 0, 0.8, 3.1]) {
				expect(
					length(sub(kleinBottlePoint(u + 2 * Math.PI, v), kleinBottlePoint(u, -v)))
				).toBeLessThan(1e-12);
				expect(
					length(sub(kleinBottlePoint(u, v + 2 * Math.PI), kleinBottlePoint(u, v)))
				).toBeLessThan(1e-12);
			}
		for (const v of [-2.7, 0, 0.8, Math.PI]) {
			const join = kleinBottlePoint(Math.PI, v);
			for (const side of [-1, 1])
				expect(length(sub(kleinBottlePoint(Math.PI + side * 1e-8, v), join))).toBeLessThan(3e-7);
		}
	});
	it.each([TREFOIL_MIN_TUBE_RATIO, TREFOIL_DEFAULT_TUBE_RATIO, TREFOIL_MAX_TUBE_RATIO])(
		'constructs a regular periodic circular tube around the harmonic trefoil at ratio %s',
		(ratio) => {
			for (const u of [0, 0.34, Math.PI / 2, 2.4, 4.67]) {
				const center: Vec3 = [
						Math.sin(u) + 2 * Math.sin(2 * u),
						Math.cos(u) - 2 * Math.cos(2 * u),
						-Math.sin(3 * u)
					],
					tangent: Vec3 = [
						Math.cos(u) + 4 * Math.cos(2 * u),
						-Math.sin(u) + 4 * Math.sin(2 * u),
						-3 * Math.cos(3 * u)
					];
				for (const v of [0, 0.43, Math.PI / 2, 3.27]) {
					const point = trefoilSurfacePoint(u, v, ratio),
						offset = sub(point, center),
						opposite = trefoilSurfacePoint(u, v + Math.PI, ratio);
					expect(length(offset)).toBeCloseTo((3 * ratio) / (1 - ratio), 12);
					expect(dot(offset, tangent)).toBeCloseTo(0, 12);
					expect(length(sub(scale(sub(point, scale(opposite, -1)), 0.5), center))).toBeLessThan(
						1e-12
					);
					expect(length(sub(trefoilSurfacePoint(u + 2 * Math.PI, v, ratio), point))).toBeLessThan(
						1e-12
					);
					expect(length(sub(trefoilSurfacePoint(u, v + 2 * Math.PI, ratio), point))).toBeLessThan(
						1e-12
					);
				}
			}
		}
	);
	it('retains exact physical tube radius and bounding radius at every permitted resolution', () => {
		for (const ratio of [
			TREFOIL_MIN_TUBE_RATIO,
			TREFOIL_DEFAULT_TUBE_RATIO,
			TREFOIL_MAX_TUBE_RATIO
		])
			for (const resolution of [8, 13, 24, 32, 64]) {
				const m = createTopologyMesh('trefoil', 14, resolution, ratio),
					nu = resolution * 4,
					nv = Math.max(8, 2 * Math.round(resolution / 3)),
					factor = (14 * (1 - ratio)) / 3;
				let maxTubeError = 0;
				for (let i = 0; i < nu; i++) {
					const u = (2 * Math.PI * i) / nu,
						center: Vec3 = scale(
							[
								Math.sin(u) + 2 * Math.sin(2 * u),
								Math.cos(u) - 2 * Math.cos(2 * u),
								-Math.sin(3 * u)
							],
							factor
						);
					for (let j = 0; j < nv; j++)
						maxTubeError = Math.max(
							maxTubeError,
							Math.abs(length(sub(m.vertices[i * nv + j], center)) - 14 * ratio)
						);
				}
				expect(maxTubeError).toBeLessThan(1e-12);
				expect(Math.max(...m.vertices.map(length))).toBeCloseTo(14, 12);
			}
		const m = mesh('trefoil');
		expect(m.vertices).toHaveLength(1536);
		expect(m.triangles).toHaveLength(3072);
		expect(m.edgeParity.flat().every((parity) => parity === 1)).toBe(true);
		expect(Math.max(...m.vertices.map(length))).toBeCloseTo(14, 12);
		expect(length(trefoilSurfacePoint(Math.PI, Math.PI))).toBeCloseTo(
			3 / (1 - TREFOIL_DEFAULT_TUBE_RATIO),
			12
		);
	});
	it('has a regular Frenet frame and exact threefold symmetry without a seam kink', () => {
		let minimumCrossZ = Infinity,
			minimumSpeed = Infinity,
			maximumSymmetryError = 0;
		for (let i = 0; i < 720; i++) {
			const u = (2 * Math.PI * i) / 720,
				first: Vec3 = [
					Math.cos(u) + 4 * Math.cos(2 * u),
					-Math.sin(u) + 4 * Math.sin(2 * u),
					-3 * Math.cos(3 * u)
				],
				second: Vec3 = [
					-Math.sin(u) - 8 * Math.sin(2 * u),
					-Math.cos(u) + 8 * Math.cos(2 * u),
					9 * Math.sin(3 * u)
				],
				crossZ = first[0] * second[1] - first[1] * second[0];
			minimumCrossZ = Math.min(minimumCrossZ, crossZ);
			minimumSpeed = Math.min(minimumSpeed, length(first));
			const point = trefoilSurfacePoint(u, 0.73),
				angle = (-2 * Math.PI) / 3,
				rotated: Vec3 = [
					point[0] * Math.cos(angle) - point[1] * Math.sin(angle),
					point[0] * Math.sin(angle) + point[1] * Math.cos(angle),
					point[2]
				];
			maximumSymmetryError = Math.max(
				maximumSymmetryError,
				length(sub(trefoilSurfacePoint(u + (2 * Math.PI) / 3, 0.73), rotated))
			);
		}
		expect(minimumCrossZ).toBeGreaterThanOrEqual(27 - 1e-12);
		expect(minimumSpeed).toBeGreaterThanOrEqual(Math.sqrt(137) / 3 - 1e-12);
		expect(maximumSymmetryError).toBeLessThan(1e-12);
		const h = 1e-4;
		for (const v of [0, 1.3, Math.PI]) {
			const derivative = (u: number) =>
				scale(sub(trefoilSurfacePoint(u + h, v), trefoilSurfacePoint(u - h, v)), 0.5 / h);
			expect(length(sub(derivative(0), derivative(2 * Math.PI)))).toBeLessThan(1e-9);
		}
	});
	it('retains independent bottle sheets at actual triangle intersections', () => {
		const m = mesh('klein'),
			intersections = findSurfaceIntersections(m, 4);
		expect(intersections).toHaveLength(4);
		for (const hit of intersections) {
			expect(
				length(sub(topologyPoint(m, hit.fromTriangle, hit.fromBarycentric), hit.point))
			).toBeLessThan(1e-9);
			expect(
				length(sub(topologyPoint(m, hit.toTriangle, hit.toBarycentric), hit.point))
			).toBeLessThan(1e-9);
			expect(
				m.triangles[hit.fromTriangle].some((id) => m.triangles[hit.toTriangle].includes(id))
			).toBe(false);
		}
	});
	it.each([TREFOIL_MIN_TUBE_RATIO, TREFOIL_DEFAULT_TUBE_RATIO, TREFOIL_MAX_TUBE_RATIO])(
		'keeps the trefoil tube embedded at permitted ratio %s',
		(ratio) => {
			for (const resolution of [12, 24, 32])
				expect(
					findSurfaceIntersections(createTopologyMesh('trefoil', 14, resolution, ratio), 1, 2)
				).toEqual([]);
		}
	);
	it.each(shapes)('keeps topology valid for coarse and finer %s tessellations', (shape) => {
		for (const resolution of [12, 32]) {
			const m = createTopologyMesh(shape, 14, resolution);
			expect(topology(m)).toEqual({
				euler: shape === 'projective' ? 1 : 0,
				boundaries: shape === 'mobius' ? 1 : 0,
				orientable: shape === 'trefoil',
				connected: true
			});
		}
	});

	it('scales area, geometry and sampling coherently and rejects invalid dimensions', () => {
		const a = createTopologyMesh('mobius', 7),
			b = mesh('mobius');
		expect(b.area / a.area).toBeCloseTo(4, 10);
		expect(() => createTopologyMesh('klein', 0)).toThrow();
		expect(() => createTopologyMesh('trefoil', 14, 5)).toThrow();
		for (const invalid of [0, 0.039, 0.161, 0.2, NaN, Infinity]) {
			expect(() => createTopologyMesh('trefoil', 14, 24, invalid)).toThrow('tube ratio');
			expect(() => trefoilSurfacePoint(0, 0, invalid)).toThrow('tube ratio');
		}
	});
});
