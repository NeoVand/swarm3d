import { describe, expect, it } from 'vitest';
import {
	createDefaultScene,
	initializePopulation,
	topologyMesh,
	topologyPoint,
	walkTopology,
	normalize,
	scale,
	subtract,
	magnitude,
	dot
} from './index';
import { createTopologyRelations, topologyRelation } from './topology-relations';
import {
	canonicalSmoothChart,
	isSmoothTopologyWorld,
	smoothTopologyAdvance,
	smoothTopologyChart,
	smoothTopologyDimensions,
	smoothTopologyRelation,
	smoothTopologySurface,
	smoothTopologyTriangle
} from './topology-smooth';
import type { SmoothTopologyShape, SmoothTopologyWorld } from './topology-smooth';
import type { Vec2, Vec3 } from './types';
import { findSurfaceIntersections } from '../../../scripts/helpers/topology-fixtures';
const shapes: SmoothTopologyShape[] = ['mobius', 'klein', 'trefoil'];
const world = (shape: SmoothTopologyShape): SmoothTopologyWorld => ({
	kind: 'surface',
	shape,
	radius: 17.5,
	...(shape === 'trefoil' ? { tubeRadius: 2.16 } : {})
});
const closeVector = (a: Vec3, b: Vec3, tolerance: number) =>
	expect(magnitude(subtract(a, b))).toBeLessThan(tolerance);

describe('continuous parametric surface dynamics', () => {
	it.each(shapes)(
		'uses C1 %s geometry and induced derivatives across every cell family',
		(shape) => {
			const w = world(shape),
				dims = smoothTopologyDimensions(shape),
				eps = 1e-8;
			for (let axis = 0; axis < 2; axis++)
				for (let i = 1; i < dims[axis]; i += 3) {
					const a: Vec2 = axis === 0 ? [i / dims[0] - eps, 0.371] : [0.371, i / dims[1] - eps],
						b: Vec2 = axis === 0 ? [i / dims[0] + eps, 0.371] : [0.371, i / dims[1] + eps],
						first = smoothTopologySurface(w, a),
						second = smoothTopologySurface(w, b);
					closeVector(first.position, second.position, 2e-5);
					closeVector(first.u, second.u, 0.004);
					closeVector(first.v, second.v, 0.004);
					closeVector(first.normal, second.normal, 2e-5);
				}
		}
	);
	it.each(shapes)(
		'keeps %s neighborhoods and forces independent of observer face tags',
		(shape) => {
			const w = world(shape),
				mesh = topologyMesh(w),
				destination: Vec2 = [0.352, 0.424];
			for (let face = 0; face < mesh.triangles.length; face += 43) {
				const edge = mesh.neighbors[face].findIndex((n) => n >= 0),
					neighbor = mesh.neighbors[face][edge],
					corners = mesh.charts[face],
					chart: Vec2 = [
						(corners[(edge + 1) % 3][0] + corners[(edge + 2) % 3][0]) / 2,
						(corners[(edge + 1) % 3][1] + corners[(edge + 2) % 3][1]) / 2
					],
					position = smoothTopologySurface(w, chart).position;
				const first = smoothTopologyChart(w, position, face),
					second = smoothTopologyChart(w, position, neighbor),
					a = smoothTopologyRelation(w, first, destination),
					b = smoothTopologyRelation(w, second, destination);
				expect(Math.abs(a.distance - b.distance)).toBeLessThan(2e-5);
				closeVector(a.displacement, b.displacement, 2e-5);
			}
		}
	);
	it.each(shapes)(
		'preserves %s speed, tangency and smooth position over moving chart boundaries',
		(shape) => {
			const w = world(shape);
			let uv: Vec2 = [0.999, 0.38],
				s = smoothTopologySurface(w, uv),
				velocity = scale(normalize(s.u), 2),
				orientation: 1 | -1 = 1;
			for (let tick = 0; tick < 240; tick++) {
				const moving = smoothTopologyAdvance(
					w,
					uv,
					scale(velocity, 1 / 60),
					velocity,
					velocity,
					orientation
				);
				expect(magnitude(moving.velocity)).toBeCloseTo(2, 8);
				closeVector(moving.position, smoothTopologySurface(w, moving.chart).position, 2e-5);
				expect(
					Math.abs(dot(moving.velocity, smoothTopologySurface(w, moving.chart).normal))
				).toBeLessThan(1e-7);
				expect(magnitude(subtract(moving.velocity, moving.transportedPriorVelocity!))).toBeLessThan(
					1e-9
				);
				expect(magnitude(subtract(moving.position, s.position))).toBeLessThan(0.034);
				uv = moving.chart;
				velocity = moving.velocity;
				orientation = moving.orientation;
				s = smoothTopologySurface(w, uv);
			}
			expect(orientation).toBe(shape === 'trefoil' ? 1 : -1);
		}
	);
	it.each(['mobius', 'klein'] as const)(
		'retains the orientation cover across positive and negative %s seams',
		(shape) => {
			const w = world(shape),
				uv: Vec2 = [0.001, 0.38],
				alternate: Vec2 = shape === 'mobius' ? [1.001, 0.62] : [1.001, -0.38];
			closeVector(
				smoothTopologySurface(w, uv).position,
				smoothTopologySurface(w, alternate).position,
				2e-5
			);
			closeVector(smoothTopologySurface(w, uv).u, smoothTopologySurface(w, alternate).u, 2e-4);
			closeVector(
				smoothTopologySurface(w, uv).v,
				scale(smoothTopologySurface(w, alternate).v, -1),
				2e-4
			);
			expect(canonicalSmoothChart(shape, alternate, -1).orientation).toBe(1);
			const negative: Vec2 = shape === 'mobius' ? [-0.999, 0.62] : [-0.999, -0.38];
			closeVector(
				smoothTopologySurface(w, negative).position,
				smoothTopologySurface(w, uv).position,
				2e-5
			);
		}
	);
	it('measures the Trefoil circular tube arc against its independent physical radius', () => {
		const w = world('trefoil'),
			radius = 2.16;
		for (const u of [0.0, 0.113, 0.314, 0.9])
			for (const v of [0.05, 0.42, 0.95]) {
				const actual = smoothTopologyRelation(w, [u, v], [u, v + 0.03]);
				expect(Math.abs(actual.distance - 2 * Math.PI * radius * 0.03)).toBeLessThan(0.0002);
			}
	});
	it('measures the Möbius centerline against an independent circle arc', () => {
		const w = world('mobius');
		for (const u of [0.0, 0.23, 0.71, 0.99]) {
			const relation = smoothTopologyRelation(w, [u, 0.5], [u + 0.01, 0.5]);
			expect(Math.abs(relation.distance - (17.5 / 1.28) * 2 * Math.PI * 0.01)).toBeLessThan(
				0.00002
			);
		}
	});
	it('keeps coincident remote Klein sheets physically separate', () => {
		const w = world('klein'),
			mesh = topologyMesh(w);
		for (const fixture of findSurfaceIntersections(mesh)) {
			const a = smoothTopologyChart(w, fixture.point, fixture.fromTriangle),
				b = smoothTopologyChart(w, fixture.point, fixture.toTriangle),
				relation = smoothTopologyRelation(w, a, b);
			expect(relation.distance).toBeGreaterThan(w.radius * 0.15);
		}
	});
	it('keeps a Möbius physical-edge reflection visible in acceleration and turning', () => {
		const w = world('mobius'),
			uv: Vec2 = [0.241, 0.99],
			surface = smoothTopologySurface(w, uv),
			velocity = scale(normalize(surface.v), 0.8),
			moved = smoothTopologyAdvance(w, uv, scale(velocity, 0.5), velocity, velocity);
		expect(dot(moved.velocity, moved.transportedPriorVelocity!)).toBeLessThan(0);
		expect(magnitude(moved.transportedPriorVelocity!)).toBeCloseTo(0.8, 8);
		expect(magnitude(subtract(moved.velocity, moved.transportedPriorVelocity!))).toBeGreaterThan(
			1.5
		);
	});
	it.each(shapes)(
		'initializes %s agents on smooth geometry rather than flat display facets',
		(shape) => {
			const scene = createDefaultScene();
			scene.world = world(shape);
			scene.species.forEach((s) => (s.population = 20));
			const agents = initializePopulation(scene).agents;
			for (const a of agents) {
				expect(a.chart).toBeDefined();
				if (!isSmoothTopologyWorld(scene.world)) throw Error('domain');
				const surface = smoothTopologySurface(scene.world, a.chart!);
				closeVector(a.position, surface.position, 1e-8);
				expect(Math.abs(dot(a.velocity, surface.normal))).toBeLessThan(1e-8);
				expect(a.triangle).toBe(smoothTopologyTriangle(scene.world, a.chart!));
			}
		}
	);
});

describe('polyhedral graph routing is not a physical lower bound', () => {
	it('includes reachable Projective neighbors along known sub-radius physical walks', () => {
		const mesh = topologyMesh({ kind: 'surface', shape: 'projective', radius: 17.5 }),
			table = createTopologyRelations(mesh, 2.625);
		let count = 0;
		for (let face = 0; face < mesh.triangles.length; face += 7) {
			const p = topologyPoint(mesh, face, [1 / 3, 1 / 3, 1 / 3]),
				direction = normalize(
					subtract(mesh.vertices[mesh.triangles[face][1]], mesh.vertices[mesh.triangles[face][0]])
				);
			for (const sign of [-1, 1]) {
				const moved = walkTopology(
					mesh,
					{ triangle: face, barycentric: [1 / 3, 1 / 3, 1 / 3] },
					scale(direction, 0.8 * sign)
				);
				expect(moved.complete).toBe(true);
				const relation = topologyRelation(table, face, moved.triangle, p, moved.position)!;
				expect(relation.distance).toBeLessThan(0.935);
				count++;
			}
		}
		expect(count).toBeGreaterThan(150);
	});
});
