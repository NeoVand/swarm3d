/** Uint32 hashing gives stable streams without relying on mutable array order. */
export function hashSeed(seed: number, value: number): number {
	let hash = (seed ^ Math.imul(value, 0x9e3779b9)) >>> 0;
	hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
	hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
	return (hash ^ (hash >>> 16)) >>> 0;
}
export function seededRandom(seed: number): () => number {
	let counter = 0;
	return () => hashSeed(seed, ++counter) / 0x100000000;
}
export function keySeed(seed: number, key: string): number {
	let result = seed >>> 0;
	for (let i = 0; i < key.length; i++) result = hashSeed(result, key.charCodeAt(i));
	return result;
}
