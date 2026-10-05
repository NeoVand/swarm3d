import type { SceneDefinition } from '#lib/model/types';
import { assertScene } from '#lib/model/validation';

export const MAX_SCENE_BYTES = 256 * 1024;
export function exportScene(scene: SceneDefinition): string {
	return JSON.stringify(assertScene(scene), null, 2);
}
export function importScene(text: string): SceneDefinition {
	if (new TextEncoder().encode(text).length > MAX_SCENE_BYTES)
		throw new Error('Scene file exceeds 256 KiB.');
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('Scene file is not valid JSON.');
	}
	return assertScene(value);
}
export function encodeSceneShare(scene: SceneDefinition): string {
	const bytes = new TextEncoder().encode(JSON.stringify(assertScene(scene)));
	if (bytes.length > MAX_SCENE_BYTES) throw new Error('Scene exceeds the share-link size limit.');
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 8192)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeSceneShare(fragment: string): SceneDefinition {
	let encoded = fragment.replace(/^#/, '').replace(/^scene=/, '');
	if (
		!encoded ||
		encoded.length > Math.ceil((MAX_SCENE_BYTES * 4) / 3) ||
		!/^[A-Za-z0-9_-]+$/.test(encoded) ||
		encoded.length % 4 === 1
	)
		throw new Error('Invalid or oversized scene share link.');
	encoded = encoded.replaceAll('-', '+').replaceAll('_', '/');
	let bytes: Uint8Array;
	try {
		const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
		bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new Error('Invalid scene share encoding.');
	}
	return importScene(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export const encodeShareScene = encodeSceneShare;
export const decodeShareScene = decodeSceneShare;
export function sceneShareUrl(scene: SceneDefinition, base?: string): string {
	const url = new URL(
		base ?? (typeof window === 'undefined' ? 'http://localhost/' : window.location.href)
	);
	url.hash = `scene=${encodeSceneShare(scene)}`;
	return url.href;
}
