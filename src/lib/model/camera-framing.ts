import type { CameraDefinition, WorldDefinition } from './types';

/** Default presentation of each world; saved scene cameras remain authoritative. */
export function worldDefaultCamera(
	world: WorldDefinition
): Pick<CameraDefinition, 'yaw' | 'pitch'> {
	if (world.shape === 'trefoil') return { yaw: 0.2, pitch: 0.12 };
	return { yaw: 0.6, pitch: world.shape === 'plane' ? 0.7 : 0.3 };
}
