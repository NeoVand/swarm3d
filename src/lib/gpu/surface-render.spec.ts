import { describe, expect, it } from 'vitest';
import {
	magnitude,
	subtract,
	worldNormal,
	dot,
	add,
	scale,
	smoothTopologySurface,
	smoothTopologyTriangle,
	topologyMesh,
	topologyPoint,
	type Vec2,
	type Vec3,
	type WorldDefinition,
	type SmoothTopologyShape
} from '#lib/model';
import { StageCamera, pickWorldRay } from './camera';
import { agentRenderCenter, surfaceViewLift } from './surface-render';

const worlds: WorldDefinition[] = [
	{ kind: 'surface', shape: 'sphere', radius: 20 },
	{ kind: 'surface', shape: 'cylinder', radius: 20, halfHeight: 24 },
	{ kind: 'surface', shape: 'torus', majorRadius: 40, tubeRadius: 20 }
];
const pointFor = (world: WorldDefinition): Vec3 =>
	world.shape === 'torus'
		? [60, 0, 0]
		: [20 * Math.cos(Math.PI / 60), 0, 20 * Math.sin(Math.PI / 60)];
describe('surface body centers remain consistent with visual picking', () => {
	it.each(worlds)('clears the analytic $shape surface skin toward either viewer side', (world) => {
		const point = pointFor(world),
			normal = worldNormal(world, point);
		const outside = point.map((v, i) => v + normal[i] * 4) as unknown as Vec3;
		const inside = point.map((v, i) => v - normal[i] * 4) as unknown as Vec3;
		expect(surfaceViewLift(world, point, outside, 0.1)).toBe(0.1);
		expect(surfaceViewLift(world, point, inside, 0.1)).toBeLessThan(-0.1);
		expect(
			dot(subtract(agentRenderCenter(world, point, 0.14, outside), point), normal)
		).toBeGreaterThan(0);
		expect(
			dot(subtract(agentRenderCenter(world, point, 0.14, inside), point), normal)
		).toBeLessThan(0);
	});
	it.each(worlds)(
		'caps extremely close $shape cosmetic offsets without moving physical state',
		(world) => {
			const point = pointFor(world),
				snapshot = [...point],
				normal = worldNormal(world, point);
			const eye = point.map((v, i) => v - normal[i] * 0.01) as unknown as Vec3;
			const rendered = agentRenderCenter(world, point, 0.14, eye);
			expect(magnitude(subtract(rendered, point))).toBeCloseTo(0.0035, 10);
			expect(dot(subtract(eye, rendered), subtract(eye, point))).toBeGreaterThan(0);
			expect(point).toEqual(snapshot);
		}
	);
	it('projects the actual close-cylinder marker where the physical point misses by over24pixels', () => {
		const world = worlds[1],
			point = pointFor(world);
		const eye: Vec3 = [point[0] * 0.98, point[1], point[2] * 0.98 + 0.2];
		const relative = subtract(eye, point),
			distance = magnitude(relative);
		const camera = new StageCamera({
			target: point,
			distance,
			yaw: Math.atan2(relative[0], relative[2]),
			pitch: 0,
			autoRotate: 0
		});
		camera.update(1.25);
		const rendered = agentRenderCenter(world, point, 0.14, camera.position);
		const physicalClip = camera.project(point),
			visualClip = camera.project(rendered);
		expect((Math.abs(visualClip[0] - physicalClip[0]) * 500) / 2).toBeGreaterThan(24);
		expect(visualClip[2]).toBeGreaterThan(0);
		expect(visualClip[2]).toBeLessThan(1);
		const ray = subtract(rendered, camera.position),
			hit = pickWorldRay(world, camera.position, ray)!;
		// The visible marker lies before the surface hit from an interior camera.
		expect(magnitude(ray)).toBeLessThan(magnitude(subtract(hit.position, camera.position)));
	});
	it.each(['mobius', 'klein', 'trefoil'] as SmoothTopologyShape[])(
		'keeps the %s display center continuous through parameter-cell boundaries',
		(shape) => {
			const world = { kind: 'surface', shape, radius: 17.5 } as const;
			const chart: Vec2 = [0.5, 0.5];
			const surface = smoothTopologySurface(world, chart),
				eye = add(surface.position, scale(surface.normal, 4));
			for (const axis of [0, 1]) {
				const a = chart.map((value, i) => value + (i === axis ? -1e-8 : 0)) as unknown as Vec2;
				const b = chart.map((value, i) => value + (i === axis ? 1e-8 : 0)) as unknown as Vec2;
				const first = agentRenderCenter(
					world,
					smoothTopologySurface(world, a).position,
					0.14,
					eye,
					smoothTopologyTriangle(world, a),
					a
				);
				const second = agentRenderCenter(
					world,
					smoothTopologySurface(world, b).position,
					0.14,
					eye,
					smoothTopologyTriangle(world, b),
					b
				);
				expect(magnitude(subtract(first, second))).toBeLessThan(4e-6);
			}
		}
	);
	it('keeps Projective display centers invariant to the incident face chosen at an edge', () => {
		const world = { kind: 'surface', shape: 'projective', radius: 14 } as const;
		const mesh = topologyMesh(world);
		let maximum = 0;
		mesh.neighbors.forEach((neighbors, face) =>
			neighbors.forEach((other, edge) => {
				if (other < face || other < 0) return;
				const bary = [0.5, 0.5, 0.5];
				bary[edge] = 0;
				const point = topologyPoint(mesh, face, bary as unknown as Vec3);
				const eye = add(point, scale(mesh.normals[face], 4));
				maximum = Math.max(
					maximum,
					magnitude(
						subtract(
							agentRenderCenter(world, point, 0.14, eye, face),
							agentRenderCenter(world, point, 0.14, eye, other)
						)
					)
				);
			})
		);
		expect(maximum).toBeLessThan(1e-6);
	});
	it('leaves solid-world coordinates untouched', () => {
		const point: Vec3 = [1, 2, 3];
		expect(
			agentRenderCenter({ kind: 'volume', shape: 'sphere', radius: 20 }, point, 0.14, [0, 0, 0])
		).toBe(point);
	});
});
