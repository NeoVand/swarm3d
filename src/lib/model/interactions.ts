import type { SceneDefinition } from '#lib/model/types';
import { worldInteractionLimit } from '#lib/model/geometry';

/** Physical query radii, including resolved rule precedence and complete contact reach. */
export function interactionRadii(scene: SceneDefinition, collisionSizeMultiplier = 1.2): number[] {
	if (!Number.isFinite(collisionSizeMultiplier) || collisionSizeMultiplier < 0)
		throw new Error('Invalid contact query multiplier.');
	const maximumSize = Math.max(...scene.species.map((s) => s.size));
	return scene.species.map((source) => {
		const contact = source.size + maximumSize;
		let radius = Math.max(
			source.perception,
			contact,
			scene.dynamics.collision > 0 ? contact * collisionSizeMultiplier : 0
		);
		for (const target of scene.species) {
			const explicit = scene.speciesRules.find((r) => r.from === source.key && r.to === target.key);
			const fallback =
				source.key === target.key
					? undefined
					: scene.speciesRules.find((r) => r.from === source.key && r.to === '*');
			const rule = explicit ?? fallback;
			if (rule && rule.behavior !== 'ignore' && rule.strength !== 0)
				radius = Math.max(radius, rule.radius ?? source.perception);
		}
		for (const rule of source.metricRules)
			if (rule.behavior !== 'ignore' && rule.strength !== 0)
				radius = Math.max(radius, rule.radius ?? source.perception);
		return radius;
	});
}
/** Same physical radius floor packed by the GPU; broadphase padding is separate. */
export function globalInteractionRadius(scene: SceneDefinition): number {
	return Math.max(...interactionRadii(scene), 0.1);
}
/** Shader obstacle force reaches beyond the intrinsic primitive by this body/avoidance margin. */
export function surfaceObstacleMargin(scene: SceneDefinition): number {
	const maximumSize = Math.max(...scene.species.map((species) => species.size));
	return maximumSize + Math.max(4 * maximumSize, 0.15 * globalInteractionRadius(scene));
}
/** Strict usable primitive radius after the complete force reach; zero means no legal brush. */
export function maxSurfaceObstacleRadius(scene: SceneDefinition): number {
	const limit = worldInteractionLimit(scene.world);
	if (!Number.isFinite(limit)) return 10000;
	return Math.max(
		0,
		Math.min(10000, limit - surfaceObstacleMargin(scene) - Math.max(1e-6, limit * 1e-6))
	);
}
