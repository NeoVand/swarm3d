import type { TopologyShape, Vec2, Vec3 } from '#lib/model/types';

/** Coordinates belong to each face, rather than globally welded vertices.
 * Keeping the last chart cell at u/v=1 makes the chart linear across a triangle
 * even when its physical vertices are identified with a reflected seam. */
export type TopologyFaceChart = readonly [Vec2, Vec2, Vec2];

export function parametricFaceCharts(nu: number, nv: number): TopologyFaceChart[] {
	const result: TopologyFaceChart[] = [];
	for (let u = 0; u < nu; u++) {
		for (let v = 0; v < nv; v++) {
			const a: Vec2 = [u / nu, v / nv],
				b: Vec2 = [(u + 1) / nu, v / nv],
				c: Vec2 = [u / nu, (v + 1) / nv],
				d: Vec2 = [(u + 1) / nu, (v + 1) / nv];
			result.push([a, b, c], [b, d, c]);
		}
	}
	return result;
}

/** Local spherical chart on the source cover of the Roman immersion.
 * The antipodal identification is (u,v) -> (u+1/2,1-v). Even longitude
 * counts and symmetric latitude families therefore descend to the quotient.
 * Longitude is unwrapped per face; a pole inherits its neighboring longitudes
 * because longitude has no value at the pole itself. */
export function projectiveFaceChart(points: readonly [Vec3, Vec3, Vec3]): TopologyFaceChart {
	const latitude = points.map((point) => Math.acos(Math.max(-1, Math.min(1, point[2]))) / Math.PI);
	const longitude = points.map((point) =>
		Math.hypot(point[0], point[1]) > 1e-12 ? Math.atan2(point[1], point[0]) / (2 * Math.PI) : NaN
	);
	const anchor = longitude.find(Number.isFinite) ?? 0;
	const unwrapped = longitude.map((value) =>
		Number.isFinite(value) ? value - Math.round(value - anchor) : NaN
	);
	const ordinary = unwrapped.filter(Number.isFinite),
		pole = ordinary.reduce((sum, value) => sum + value, 0) / Math.max(ordinary.length, 1);
	return unwrapped.map((value, index) => [
		Number.isFinite(value) ? value : pole,
		latitude[index]
	]) as unknown as TopologyFaceChart;
}

/** Sparse chart rulings, not Cartesian slices of an immersed surface.
 * Keep these counts in parity with the world shader. */
export function topologyGridCounts(shape: TopologyShape): Vec2 {
	if (shape === 'klein') return [12, 8];
	if (shape === 'projective') return [8, 6];
	return [12, 4];
}

/** Projective guides use linear fields on the source sphere, rather than
 * interpolated longitude at a pole. Four planes give eight meridians; two
 * latitude slots cover each face's small spherical span. These field contours
 * descend through antipodal identification, including the source poles. */
export function projectiveGridFixture(chart: TopologyFaceChart, slot: number) {
	const source = chart.map(([u, v]) => {
		const latitude = v * Math.PI,
			longitude = u * 2 * Math.PI;
		return [
			Math.sin(latitude) * Math.cos(longitude),
			Math.sin(latitude) * Math.sin(longitude),
			Math.cos(latitude)
		] as Vec3;
	});
	// A tilted source frame keeps guides away from the Roman immersion's double
	// curves. Source coordinate great circles collapse onto coincident image axes.
	const unit = (point: Vec3): Vec3 =>
		point.map((value) => value / Math.hypot(...point)) as unknown as Vec3;
	const axis = unit([0.31, 0.79, 0.53]),
		x = unit([-axis[1], axis[0], 0]),
		y: Vec3 = [-axis[2] * x[1], axis[2] * x[0], axis[0] * x[1] - axis[1] * x[0]];
	const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	if (slot < 4) {
		const angle = (slot * 2 * Math.PI) / 8,
			normal: Vec3 = x.map(
				(value, index) => -value * Math.sin(angle) + y[index] * Math.cos(angle)
			) as unknown as Vec3;
		return {
			chart: source.map((point) => [dot(point, normal), 0]) as unknown as TopologyFaceChart,
			level: 0
		};
	}
	const values = source.map((point) => dot(point, axis));
	const high = Math.max(...values),
		latitude =
			Math.floor((Math.acos(Math.max(-1, Math.min(1, high))) * 6) / Math.PI + 1e-7) + 1 + slot - 4;
	return {
		chart: values.map((value) => [value, 0]) as unknown as TopologyFaceChart,
		level: latitude < 6 ? Math.cos((latitude * Math.PI) / 6) : -2
	};
}

/** Independent CPU reference for a face-local guide segment. Half-open chart
 * ownership draws an edge once, including the periodic/reflected seams. */
export function topologyGridSegment(
	points: readonly [Vec3, Vec3, Vec3],
	chart: TopologyFaceChart,
	family: 0 | 1,
	level: number,
	includeMinimum = false
): readonly [Vec3, Vec3] | undefined {
	const values = chart.map((point) => point[family]),
		low = Math.min(...values),
		high = Math.max(...values),
		epsilon = 1e-7;
	if (
		high - low < epsilon ||
		(includeMinimum ? level < low - epsilon : level <= low + epsilon) ||
		level > high + epsilon
	)
		return;
	const intersections: Vec3[] = [];
	for (let edge = 0; edge < 3; edge++) {
		const next = (edge + 1) % 3,
			change = values[next] - values[edge];
		if (Math.abs(change) < epsilon) continue;
		const fraction = (level - values[edge]) / change;
		if (fraction < -epsilon || fraction > 1 + epsilon) continue;
		const t = Math.max(0, Math.min(1, fraction));
		const point =
			t <= epsilon
				? points[edge]
				: t >= 1 - epsilon
					? points[next]
					: (points[edge].map(
							(value, axis) => value + (points[next][axis] - value) * t
						) as unknown as Vec3);
		if (
			!intersections.some(
				(other) => Math.hypot(...point.map((value, i) => value - other[i])) < 1e-7
			)
		)
			intersections.push(point);
	}
	return intersections.length === 2 ? [intersections[0], intersections[1]] : undefined;
}
