import { describe, expect, it } from 'vitest';
import { createDefaultScene } from './defaults';
import { decodeSceneShare, encodeSceneShare, exportScene, importScene } from './serialization';
import { validateScene } from './validation';

describe('camera framing scene data', () => {
	it('restores pan and its independent focus through saved and shared scenes', () => {
		const scene = createDefaultScene();
		scene.camera.target = [3, -2, 7];
		scene.camera.pan = [0.6, -0.25];
		expect(importScene(exportScene(scene)).camera).toEqual(scene.camera);
		expect(decodeSceneShare(encodeSceneShare(scene)).camera).toEqual(scene.camera);
	});

	it('accepts legacy camera definitions without adding a new pivot or pan', () => {
		const scene = createDefaultScene();
		delete scene.camera.pan;
		scene.camera.target = [1, 2, 3];
		const validated = validateScene(scene);
		expect(validated.ok).toBe(true);
		if (validated.ok) expect(validated.scene.camera).toEqual(scene.camera);
	});

	it('rejects malformed and nonfinite framing offsets', () => {
		for (const pan of [null, [1], [1, 2, 3], [NaN, 0], [0, Infinity], ['0', 0]]) {
			const scene = createDefaultScene();
			expect(validateScene({ ...scene, camera: { ...scene.camera, pan } }).ok).toBe(false);
		}
	});
});
