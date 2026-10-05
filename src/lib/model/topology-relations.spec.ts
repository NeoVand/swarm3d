import { describe, expect, it } from 'vitest';
import type { AgentState, TopologyShape, Vec3 } from './types';
import { createTopologyMesh, topologyPoint } from './topology-mesh';
import type { TopologyMesh } from './topology-mesh';
import {
	createTopologyRelations,
	rotateTopologyVector,
	topologyRelation,
	unfoldTopologyEdge
} from './topology-relations';
import { topologyMesh } from './topology-world';
import {
	add,
	allPairsNeighbors,
	createNeighborGrid,
	cross,
	dot,
	localFrame,
	magnitude,
	normalize,
	scale,
	subtract,
	worldAdvance,
	worldDisplacement,
	worldDistance,
	worldExp,
	worldInteractionLimit,
	worldNormal,
	worldTransport
} from './geometry';
import { createDefaultScene } from './defaults';
import { measureAllPairs } from './oracles';
import { findSurfaceIntersections } from '../../../scripts/helpers/topology-fixtures';

const shapes: TopologyShape[] = ['mobius', 'klein', 'projective', 'trefoil'];
const worlds = new Map(
	shapes.map((shape) => [shape, { kind: 'surface', shape, radius: 14 } as const])
);
const point = (mesh: TopologyMesh, triangle: number) =>
	topologyPoint(mesh, triangle, [1 / 3, 1 / 3, 1 / 3]);
const agent = (
	id: number,
	position: Vec3,
	triangle: number,
	velocity: Vec3 = [0, 0, 0]
): AgentState => ({
	id,
	birth: id,
	speciesKey: 'shoal',
	position,
	velocity,
	triangle,
	orientation: 1
});

describe('local unfolded topology neighborhood classifier', () => {
	it.each(shapes)('preserves same-face and adjacent %s lengths and transport', (shape) => {
		const mesh = createTopologyMesh(shape, 14, 12),
			table = createTopologyRelations(mesh, 2.1),
			from = 0;
		const edge = mesh.neighbors[from].findIndex((next) => next >= 0),
			to = mesh.neighbors[from][edge],
			p = point(mesh, from),
			q = point(mesh, to);
		const indices = mesh.triangles[to],
			velocity = normalize(subtract(mesh.vertices[indices[1]], mesh.vertices[indices[0]]));
		const relation = topologyRelation(table, from, to, p, q, velocity)!;
		const unfolding = unfoldTopologyEdge(mesh, from, edge);
		const expected = subtract(
			add(rotateTopologyVector(unfolding.rotation, q), unfolding.translation),
			p
		);
		expect(magnitude(subtract(relation.displacement, expected))).toBeLessThan(1e-9);
		expect(relation.distance).toBeCloseTo(magnitude(expected), 8);
		expect(magnitude(relation.velocity)).toBeCloseTo(1, 9);
		expect(dot(relation.velocity, mesh.normals[from])).toBeCloseTo(0, 9);
		const reverse = topologyRelation(table, to, from, q, p, relation.velocity)!;
		expect(reverse.distance).toBeCloseTo(relation.distance, 9);
		expect(magnitude(subtract(reverse.velocity, velocity))).toBeLessThan(1e-9);
		const same = topologyRelation(table, from, from, p, mesh.vertices[mesh.triangles[from][1]])!;
		expect(same.distance).toBeCloseTo(
			magnitude(subtract(mesh.vertices[mesh.triangles[from][1]], p)),
			9
		);
	});
	it.each(shapes)(
		'keeps complete crowded %s neighbors through the spatial broad phase',
		(shape) => {
			const world = worlds.get(shape)!,
				mesh = topologyMesh(world),
				p = point(mesh, 0);
			const crowd = Array.from({ length: 220 }, (_, i) => agent(i + 1, p, 0));
			const grid = createNeighborGrid(world, crowd, 0.3),
				radii = [0.05, 0.7, worldInteractionLimit(world) * 0.999];
			for (const radius of radii) {
				const reference = allPairsNeighbors(world, crowd, 0, radius),
					actual = grid.query(0, radius);
				expect(reference).toHaveLength(219);
				expect(actual.map((n) => n.id).sort((a, b) => a - b)).toEqual(reference.map((n) => n.id));
				expect(new Set(actual.map((n) => n.id)).size).toBe(219);
			}
			expect(() => grid.query(0, worldInteractionLimit(world))).toThrow(/radius/);
		}
	);
	it.each(['klein', 'projective'] as const)(
		'excludes coincident remote %s sheets from neighborhoods',
		(shape) => {
			const world = worlds.get(shape)!,
				mesh = topologyMesh(world);
			const intersections = findSurfaceIntersections(mesh);
			expect(intersections).toHaveLength(8);
			for (const fixture of intersections) {
				const { point: position, fromTriangle: from, toTriangle: to } = fixture;
				const first = topologyPoint(mesh, from, fixture.fromBarycentric),
					second = topologyPoint(mesh, to, fixture.toBarycentric);
				expect(magnitude(subtract(first, position))).toBeLessThan(1e-9);
				expect(magnitude(subtract(second, position))).toBeLessThan(1e-9);
				expect(Math.min(...fixture.fromBarycentric, ...fixture.toBarycentric)).toBeGreaterThan(
					-1e-9
				);
				const agents = [agent(1, position, from), agent(2, position, to)];
				expect(magnitude(subtract(agents[0].position, agents[1].position))).toBe(0);
				const radius = worldInteractionLimit(world) * 0.999;
				for (const observer of [0, 1]) {
					expect(allPairsNeighbors(world, agents, observer, radius)).toHaveLength(0);
					expect(createNeighborGrid(world, agents, 0.3).query(observer, radius)).toHaveLength(0);
				}
				expect(worldDistance(world, position, position, from, to)).toBeGreaterThan(radius);
			}
		}
	);
	it.each(shapes)('has rotationally invariant local %s paths', (shape) => {
		const mesh = createTopologyMesh(shape, 14, 12),
			axis = normalize([0.3, 0.7, 0.2]),
			angle = 0.731;
		const rotate = (p: Vec3) =>
			add(
				add(scale(p, Math.cos(angle)), scale(cross(axis, p), Math.sin(angle))),
				scale(axis, dot(axis, p) * (1 - Math.cos(angle)))
			);
		const rotated = {
			...mesh,
			vertices: mesh.vertices.map(rotate),
			normals: mesh.normals.map(rotate)
		};
		const table = createTopologyRelations(mesh, 2.1),
			rotatedTable = createTopologyRelations(rotated, 2.1);
		const origin = 0,
			p = point(mesh, origin);
		for (const target of table.rows[origin].slice(0, 20).map((row) => row.target)) {
			const q = point(mesh, target),
				first = topologyRelation(table, origin, target, p, q)!,
				second = topologyRelation(rotatedTable, origin, target, rotate(p), rotate(q))!;
			expect(second.distance).toBeCloseTo(first.distance, 7);
			expect(magnitude(subtract(second.displacement, rotate(first.displacement)))).toBeLessThan(
				1e-6
			);
		}
	});
	it.each(shapes)('uses tagged %s normals, basis and motion in CPU references', (shape) => {
		const world = worlds.get(shape)!,
			mesh = topologyMesh(world),
			from = 0,
			p = point(mesh, from),
			frame = localFrame(world, p, from, -1);
		expect(dot(frame[0], worldNormal(world, p, from, -1))).toBeCloseTo(0, 10);
		expect(dot(frame[1], worldNormal(world, p, from, -1))).toBeCloseTo(0, 10);
		const velocity = scale(frame[0], 0.2),
			q = worldExp(world, p, velocity, from, -1),
			moved = worldAdvance(world, p, velocity, 1, 0, velocity, from, -1);
		expect(magnitude(subtract(moved.position, q))).toBeLessThan(1e-9);
		expect(moved.triangle).toBeDefined();
		expect(moved.orientation).toBe(-1);
		expect(magnitude(moved.velocity)).toBeCloseTo(0.2, 9);
		const transported = worldTransport(world, velocity, p, moved.position, from, moved.triangle);
		expect(magnitude(subtract(transported, moved.transportedPriorVelocity!))).toBeLessThan(1e-9);
		expect(
			magnitude(worldDisplacement(world, p, moved.position, from, moved.triangle))
		).toBeCloseTo(0.2, 8);
	});
	it.each(shapes)('selects identical normalized %s corridors across supported scales', (shape) => {
		const referenceMesh = createTopologyMesh(shape, 1);
		const reference = createTopologyRelations(referenceMesh, 0.15);
		for (const radius of [2, 14, 19, 65]) {
			const mesh = createTopologyMesh(shape, radius),
				table = createTopologyRelations(mesh, radius * 0.15);
			let mismatches = 0,
				costError = 0,
				rotationError = 0,
				translationError = 0;
			expect(table.rows.length).toBe(reference.rows.length);
			// Compare every entry; aggregate errors rather than allocating millions
			// of assertions during the normal unit suite.
			for (let face = 0; face < table.rows.length; face++) {
				const row = table.rows[face],
					expected = reference.rows[face];
				if (row.length !== expected.length) {
					mismatches++;
					continue;
				}
				for (let i = 0; i < row.length; i++) {
					if (row[i].target !== expected[i].target) mismatches++;
					costError = Math.max(costError, Math.abs(row[i].cost / radius - expected[i].cost));
					for (let column = 0; column < 3; column++)
						rotationError = Math.max(
							rotationError,
							magnitude(subtract(row[i].rotation[column], expected[i].rotation[column]))
						);
					translationError = Math.max(
						translationError,
						magnitude(subtract(scale(row[i].translation, 1 / radius), expected[i].translation))
					);
				}
			}
			expect(mismatches).toBe(0);
			expect(costError).toBeLessThan(1e-10);
			expect(rotationError).toBeLessThan(1e-9);
			expect(translationError).toBeLessThan(1e-9);
		}
	});

	it('retains the pre-bounce velocity when measuring a physical Möbius reflection', () => {
		const world = worlds.get('mobius')!,
			mesh = topologyMesh(world),
			face = mesh.neighbors.findIndex((row) => row.includes(-1)),
			edge = mesh.neighbors[face].indexOf(-1),
			p = point(mesh, face);
		const weights = [0.5, 0.5, 0.5];
		weights[edge] = 0;
		const midpoint = topologyPoint(mesh, face, weights as unknown as Vec3),
			velocity = scale(subtract(midpoint, p), 1.25);
		const moved = worldAdvance(world, p, velocity, 1, 0, velocity, face, 1);
		expect(magnitude(subtract(moved.transportedPriorVelocity!, velocity))).toBeLessThan(1e-9);
		expect(dot(moved.velocity, velocity)).toBeLessThan(0);
		const scene = createDefaultScene();
		scene.world = world;
		scene.species.forEach((s) => (s.perception = 0.5));
		const prior = agent(1, p, face, velocity),
			current = agent(1, moved.position, moved.triangle!, moved.velocity);
		expect(() => measureAllPairs(scene, [current], [prior], 1)).toThrow(/actual motion path/);
		const metrics = measureAllPairs(
			scene,
			[current],
			[prior],
			1,
			undefined,
			new Map([[1, moved.transportedPriorVelocity!]])
		);
		expect(metrics[0].turnRate).toBeGreaterThan(Math.PI / 2);
		expect(metrics[0].acceleration).toBeGreaterThan(0);
	});
});
