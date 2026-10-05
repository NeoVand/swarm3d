import type { SceneDefinition } from '#lib/model';

/** Population-weighted intent, so a mixed species field does not promise one direction. */
export function forceVisualStyle(scene: SceneDefinition) {
	let population = 0,
		response = 0,
		vortex = 0;
	for (const species of scene.species) {
		population += species.population;
		response +=
			species.population *
			species.cursor.strength *
			(species.cursor.response === 'attract' ? 1 : species.cursor.response === 'repel' ? -1 : 0);
		vortex += species.population * species.cursor.vortex;
	}
	response /= Math.max(1, population);
	vortex /= Math.max(1, population);
	const enabled = scene.forces.enabled && scene.forces.power > 0;
	const color = !enabled
		? [0.38, 0.43, 0.46]
		: Math.abs(vortex) > Math.abs(response)
			? [0.72, 0.52, 1]
			: response > 1e-6
				? [0.28, 0.88, 0.87]
				: response < -1e-6
					? [1, 0.4, 0.58]
					: [0.7, 0.82, 0.85];
	return {
		color: [...color, Number(enabled)],
		intent: [
			response / Math.max(Math.abs(response), Math.abs(vortex), 1e-7),
			vortex / Math.max(Math.abs(response), Math.abs(vortex), 1e-7),
			0,
			0
		]
	};
}
