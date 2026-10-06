import { describe, expect, it } from 'vitest';
import type { Vec3 } from '#lib/model/types';
import { createTopologyMesh, topologyBarycentric } from './topology-mesh';
import {
	parametricFaceCharts,
	projectiveFaceChart,
	projectiveGridFixture,
	topologyGridCounts,
	topologyGridSegment
} from './topology-chart';

const triangle: readonly [Vec3, Vec3, Vec3] = [
	[0, 0, 0],
	[2, 0, 0],
	[0, 2, 0]
];

describe('intrinsic topology guide charts', () => {
	it('keeps the last periodic cell linear instead of wrapping a corner to zero', () => {
		const charts = parametricFaceCharts(12, 8);
		expect(charts).toHaveLength(12 * 8 * 2);
		expect(charts.at(-1)).toEqual([
			[1, 7 / 8],
			[1, 1],
			[11 / 12, 1]
		]);
		for (const chart of charts) {
			for (const axis of [0, 1]) {
				const values = chart.map((point) => point[axis]);
				expect(Math.max(...values) - Math.min(...values)).toBeCloseTo(axis === 0 ? 1 / 12 : 1 / 8);
			}
		}
	});
	it('produces a physical segment inside its face at the requested chart coordinate', () => {
		const chart = [
			[0, 0],
			[1, 0],
			[0, 1]
		] as const;
		expect(topologyGridSegment(triangle, chart, 0, 0.25)).toEqual([
			[0.5, 0, 0],
			[0.5, 1.5, 0]
		]);
		expect(topologyGridSegment(triangle, chart, 1, 0.5)).toEqual([
			[1, 1, 0],
			[0, 1, 0]
		]);
		expect(topologyGridSegment(triangle, chart, 0, 1.5)).toBeUndefined();
	});
	it('owns a contour on a shared edge once and rejects vertex-only intersections', () => {
		const highSide = [
				[0, 0],
				[0.5, 0],
				[0.5, 1]
			] as const,
			lowSide = [
				[0.5, 0],
				[1, 0],
				[0.5, 1]
			] as const;
		expect(topologyGridSegment(triangle, highSide, 0, 0.5)).toBeDefined();
		expect(topologyGridSegment(triangle, lowSide, 0, 0.5)).toBeUndefined();
		expect(
			topologyGridSegment(
				triangle,
				[
					[0, 0],
					[0.5, 0],
					[0, 1]
				],
				0,
				0.5
			)
		).toBeUndefined();
	});
	it('unwraps a genuine projective cover chart across the longitude seam', () => {
		const sphere = (turn: number, z: number): Vec3 => {
			const radius = Math.sqrt(1 - z * z),
				angle = turn * 2 * Math.PI;
			return [radius * Math.cos(angle), radius * Math.sin(angle), z];
		};
		const chart = projectiveFaceChart([sphere(0.49, 0.1), sphere(-0.49, 0.1), sphere(0.48, -0.1)]);
		expect(chart[1][0]).toBeCloseTo(0.51);
		expect(Math.max(...chart.map((p) => p[0])) - Math.min(...chart.map((p) => p[0]))).toBeCloseTo(
			0.03
		);
		const pole = projectiveFaceChart([[0, 0, 1], sphere(0.1, 0.8), sphere(0.2, 0.8)]);
		expect(pole[0][0]).toBeCloseTo(0.15);
		expect(pole[0][1]).toBe(0);
	});
	it('uses quotient-invariant projective guide families', () => {
		const [longitude, latitude] = topologyGridCounts('projective');
		for (let i = 0; i < longitude; i++)
			expect(((i / longitude + 0.5) % 1) * longitude).toBeCloseTo(
				Math.round(((i / longitude + 0.5) % 1) * longitude)
			);
		for (let i = 0; i <= latitude; i++)
			expect((1 - i / latitude) * latitude).toBeCloseTo(latitude - i);
	});
	it('uses genuine source-sphere planes at the projective poles', () => {
		const cover = [
				[0, 0, 1],
				[0.4, 0, Math.sqrt(0.84)],
				[0, 0.4, Math.sqrt(0.84)]
			] as const,
			chart = projectiveFaceChart(cover),
			flipped = projectiveFaceChart(
				cover.map((point) => point.map((value) => -value)) as unknown as readonly [Vec3, Vec3, Vec3]
			);
		for (let slot = 0; slot < 4; slot++) {
			const fixture = projectiveGridFixture(chart, slot),
				opposite = projectiveGridFixture(flipped, slot);
			fixture.chart.forEach((point, corner) =>
				expect(point[0]).toBeCloseTo(-opposite.chart[corner][0], 10)
			);
			expect(Number.isFinite(fixture.chart[0][0])).toBe(true);
			const shiftedPole = projectiveGridFixture(
				[[chart[0][0] + 0.3, chart[0][1]], chart[1], chart[2]],
				slot
			);
			expect(shiftedPole.chart[0][0]).toBeCloseTo(fixture.chart[0][0], 10);
		}
	});
	it.each(['mobius', 'klein', 'trefoil'] as const)(
		'joins the %s guide curves through actual topology seams without loose ends',
		(shape) => {
			const mesh = createTopologyMesh(shape, 14),
				counts = topologyGridCounts(shape);
			const boundaryVertices = new Set<number>(),
				boundaryEdges = new Set<string>();
			mesh.triangles.forEach((triangle, face) =>
				mesh.neighbors[face].forEach((neighbor, edge) => {
					if (neighbor >= 0) return;
					const pair = [triangle[(edge + 1) % 3], triangle[(edge + 2) % 3]].sort((a, b) => a - b);
					pair.forEach((vertex) => boundaryVertices.add(vertex));
					boundaryEdges.add(pair.join(','));
				})
			);
			for (const family of [0, 1] as const) {
				const degrees = new Map<string, number>(),
					onBoundary = new Set<string>();
				mesh.triangles.forEach((triangle, face) => {
					const chart = mesh.charts[face],
						points = triangle.map((vertex) => mesh.vertices[vertex]) as unknown as readonly [
							Vec3,
							Vec3,
							Vec3
						];
					const low = Math.min(...chart.map((point) => point[family]));
					for (let ordinal = 0; ordinal < 3; ordinal++) {
						const level =
							(Math.floor((low + 1e-7) * counts[family]) + 1 + ordinal) / counts[family];
						if (shape === 'mobius' && family === 1 && (level <= 1e-7 || level >= 1 - 1e-7))
							continue;
						const segment = topologyGridSegment(points, chart, family, level);
						if (!segment) continue;
						for (const endpoint of segment) {
							const bary = topologyBarycentric(mesh, face, endpoint),
								vertexCorner = bary.findIndex((weight) => weight > 1 - 1e-7);
							let key: string, boundary: boolean;
							if (vertexCorner >= 0) {
								key = `v:${triangle[vertexCorner]}`;
								boundary = boundaryVertices.has(triangle[vertexCorner]);
							} else {
								const corners = [0, 1, 2]
									.filter((corner) => bary[corner] > 1e-7)
									.sort((a, b) => triangle[a] - triangle[b]);
								expect(corners).toHaveLength(2);
								const edge = corners.map((corner) => triangle[corner]).join(','),
									fraction = bary[corners[1]] / (bary[corners[0]] + bary[corners[1]]);
								key = `e:${edge}:${fraction.toFixed(6)}`;
								boundary = boundaryEdges.has(edge);
							}
							degrees.set(key, (degrees.get(key) ?? 0) + 1);
							if (boundary) onBoundary.add(key);
						}
					}
				});
				expect(degrees.size).toBeGreaterThan(20);
				for (const [key, degree] of degrees) expect(degree, key).toBe(onBoundary.has(key) ? 1 : 2);
			}
		}
	);
});
