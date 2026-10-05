import type { SceneDefinition } from '#lib/model';
import { HISTORY_SAMPLES } from './packing';

/** Particle slots use the same key order as population reconciliation. */
export function trailSpeciesRanges(scene: SceneDefinition) {
	let firstInstance = 0;
	return [...scene.species]
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((species) => {
			const range = { key: species.key, firstInstance, instances: species.population };
			firstInstance += species.population;
			return range;
		});
}

export function trailSegmentCount(
	seconds: number,
	sampleSeconds: number,
	headSeconds: number,
	validHistory: number
) {
	return seconds > 0
		? Math.min(
				HISTORY_SAMPLES - 1,
				validHistory,
				1 + Math.max(0, Math.ceil((seconds - headSeconds) / sampleSeconds))
			)
		: 0;
}

/** Four unique vertices form each pair of triangles; one pattern fits every agent. */
export function trailQuadIndices() {
	const corners = [0, 1, 2, 2, 1, 3];
	return Uint16Array.from(
		{ length: (HISTORY_SAMPLES - 1) * 6 },
		(_, index) => Math.floor(index / 6) * 4 + corners[index % 6]
	);
}
