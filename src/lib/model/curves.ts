import type { CurvePresetId, MonotoneCurve } from '#lib/model/types';

export const CURVE_PRESETS: ReadonlyArray<{
	id: CurvePresetId;
	name: string;
	curve: MonotoneCurve;
}> = [
	{
		id: 'linear',
		name: 'Linear',
		curve: {
			points: [
				[0, 0],
				[1, 1]
			]
		}
	},
	{
		id: 's-curve',
		name: 'S-curve',
		curve: {
			points: [
				[0, 0],
				[0.25, 0.1],
				[0.75, 0.9],
				[1, 1]
			]
		}
	},
	{
		id: 'boost-low',
		name: 'BoostLow',
		curve: {
			points: [
				[0, 0],
				[0.25, 0.5],
				[1, 1]
			]
		}
	},
	{
		id: 'boost-high',
		name: 'BoostHigh',
		curve: {
			points: [
				[0, 0],
				[0.75, 0.5],
				[1, 1]
			]
		}
	},
	{
		id: 'inverted',
		name: 'Inverted',
		curve: {
			points: [
				[0, 1],
				[1, 0]
			]
		}
	},
	{
		id: 'exp-rise',
		name: 'ExpRise',
		curve: {
			points: [
				[0, 0.1],
				[0.6, 0.15],
				[0.85, 0.55],
				[1, 0.9]
			]
		}
	},
	{
		id: 'exp-decay',
		name: 'ExpDecay',
		curve: {
			points: [
				[0, 0.9],
				[0.15, 0.55],
				[0.4, 0.15],
				[1, 0.1]
			]
		}
	},
	{
		id: 'bowl',
		name: 'Bowl',
		curve: {
			points: [
				[0, 0.9],
				[0.3, 0.2],
				[0.7, 0.2],
				[1, 0.9]
			]
		}
	},
	{
		id: 'bell',
		name: 'Bell',
		curve: {
			points: [
				[0, 0.1],
				[0.3, 0.8],
				[0.7, 0.8],
				[1, 0.1]
			]
		}
	}
];

export function curvePreset(id: CurvePresetId): MonotoneCurve {
	const preset = CURVE_PRESETS.find((item) => item.id === id);
	if (!preset) throw new Error(`Unknown curve preset: ${id}`);
	return { points: preset.curve.points.map(([x, y]) => [x, y]) };
}

/** Fritsch–Carlson slopes prevent new extrema, including beside Bowl/Bell's turning points. */
export function curveTangents(curve: MonotoneCurve): number[] {
	const points = curve.points;
	if (points.length < 2 || points[0][0] !== 0 || points.at(-1)![0] !== 1)
		throw new Error('Curve must cover [0,1].');
	for (let i = 0; i < points.length; i++) {
		const [x, y] = points[i];
		if (
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			x < 0 ||
			x > 1 ||
			y < 0 ||
			y > 1 ||
			(i > 0 && x <= points[i - 1][0])
		)
			throw new Error('Invalid curve point.');
	}
	const slopes = points.slice(1).map(([x, y], i) => (y - points[i][1]) / (x - points[i][0]));
	const tangents = points.map((_, i) =>
		i === 0
			? slopes[0]
			: i === points.length - 1
				? slopes.at(-1)!
				: slopes[i - 1] * slopes[i] <= 0
					? 0
					: (slopes[i - 1] + slopes[i]) / 2
	);
	for (let i = 0; i < slopes.length; i++) {
		if (slopes[i] === 0) {
			tangents[i] = 0;
			tangents[i + 1] = 0;
			continue;
		}
		const a = tangents[i] / slopes[i];
		const b = tangents[i + 1] / slopes[i];
		const magnitude = Math.hypot(a, b);
		if (magnitude > 3) {
			tangents[i] = ((3 * a) / magnitude) * slopes[i];
			tangents[i + 1] = ((3 * b) / magnitude) * slopes[i];
		}
	}
	return tangents;
}

export function evaluateCurve(curve: MonotoneCurve, value: number): number {
	if (!Number.isFinite(value)) throw new Error('Curve input must be finite.');
	const x = Math.max(0, Math.min(1, value));
	const points = curve.points;
	const tangents = curveTangents(curve);
	let i = 0;
	while (i < points.length - 2 && x > points[i + 1][0]) i++;
	const [x0, y0] = points[i];
	const [x1, y1] = points[i + 1];
	const width = x1 - x0;
	const t = (x - x0) / width;
	const t2 = t * t,
		t3 = t2 * t;
	const y =
		(2 * t3 - 3 * t2 + 1) * y0 +
		(t3 - 2 * t2 + t) * width * tangents[i] +
		(-2 * t3 + 3 * t2) * y1 +
		(t3 - t2) * width * tangents[i + 1];
	return Math.max(Math.min(y0, y1), Math.min(Math.max(y0, y1), y));
}

export function sampleCurve(curve: MonotoneCurve, length = 32): Float32Array {
	if (!Number.isSafeInteger(length) || length < 2)
		throw new Error('A curve table needs at least two samples.');
	return Float32Array.from({ length }, (_, i) => evaluateCurve(curve, i / (length - 1)));
}
