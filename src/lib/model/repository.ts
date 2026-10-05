import type { SavedScene, SceneDefinition, SceneRepository } from '#lib/model/types';
import { assertScene } from '#lib/model/validation';

function validThumbnail(thumbnail: string | undefined): void {
	if (
		thumbnail !== undefined &&
		(thumbnail.length > 2 * 1024 * 1024 ||
			!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(thumbnail))
	)
		throw new Error('Invalid scene thumbnail.');
}
function validRecord(record: SavedScene): SavedScene {
	const scene = assertScene(record.scene);
	if (
		record.id !== scene.id ||
		record.name !== scene.name ||
		!Number.isFinite(record.createdAt) ||
		!Number.isFinite(record.updatedAt) ||
		record.createdAt < 0 ||
		record.updatedAt < record.createdAt
	)
		throw new Error('Invalid saved-scene metadata.');
	validThumbnail(record.thumbnail);
	return { ...record, scene };
}

/** Browser storage is opened lazily, so importing this module during SSR is safe. */
export class IndexedDbSceneRepository implements SceneRepository {
	private database: Promise<IDBDatabase> | undefined;
	constructor(private readonly name = 'swarm3d-scenes') {}
	private open(): Promise<IDBDatabase> {
		if (this.database) return this.database;
		this.database = new Promise((resolve, reject) => {
			if (typeof indexedDB === 'undefined') {
				reject(new Error('Scene storage is unavailable in this environment.'));
				return;
			}
			const request = indexedDB.open(this.name, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore('scenes', { keyPath: 'id' });
			};
			request.onsuccess = () => {
				const database = request.result;
				database.onversionchange = () => {
					database.close();
					this.database = undefined;
				};
				resolve(database);
			};
			request.onerror = () => reject(request.error ?? new Error('Could not open scene storage.'));
			request.onblocked = () =>
				reject(new Error('Scene storage upgrade is blocked by another tab.'));
		});
		this.database.catch(() => {
			this.database = undefined;
		});
		return this.database;
	}
	private async transaction<T>(
		mode: IDBTransactionMode,
		operation: (
			store: IDBObjectStore,
			finish: (result: T) => void,
			observe: <Value>(request: IDBRequest<Value>, callback: (value: Value) => void) => void
		) => void
	): Promise<T> {
		const database = await this.open();
		return new Promise<T>((resolve, reject) => {
			const transaction = database.transaction('scenes', mode);
			let result: T;
			transaction.oncomplete = () => resolve(result);
			transaction.onabort = transaction.onerror = () =>
				reject(transaction.error ?? new Error('Scene storage transaction failed.'));
			const observe = <Value>(request: IDBRequest<Value>, callback: (value: Value) => void) => {
				request.onsuccess = () => {
					try {
						callback(request.result);
					} catch (error) {
						transaction.abort();
						reject(error);
					}
				};
			};
			try {
				operation(
					transaction.objectStore('scenes'),
					(value) => {
						result = value;
					},
					observe
				);
			} catch (error) {
				transaction.abort();
				reject(error);
			}
		});
	}
	async list(): Promise<SavedScene[]> {
		return this.transaction('readonly', (store, finish, observe) => {
			observe(store.getAll(), (records) =>
				finish(
					(records as SavedScene[])
						.map(validRecord)
						.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
				)
			);
		});
	}
	async get(id: string): Promise<SavedScene | undefined> {
		return this.transaction('readonly', (store, finish, observe) => {
			observe(store.get(id), (record) => finish(record ? validRecord(record) : undefined));
		});
	}
	async put(value: SceneDefinition, thumbnail?: string): Promise<SavedScene> {
		const scene = assertScene(value);
		validThumbnail(thumbnail);
		return this.transaction('readwrite', (store, finish, observe) => {
			observe(store.get(scene.id), (value) => {
				const previous = value ? validRecord(value) : undefined;
				const now = Math.max(Date.now(), previous?.updatedAt ?? 0);
				const record: SavedScene = {
					id: scene.id,
					name: scene.name,
					createdAt: previous?.createdAt ?? now,
					updatedAt: now,
					scene,
					...(thumbnail === undefined
						? previous?.thumbnail === undefined
							? {}
							: { thumbnail: previous.thumbnail }
						: { thumbnail })
				};
				store.put(record);
				finish(record);
			});
		});
	}
	async remove(id: string): Promise<SavedScene | undefined> {
		return this.transaction('readwrite', (store, finish, observe) => {
			observe(store.get(id), (record) => {
				const previous = record ? validRecord(record) : undefined;
				if (previous) store.delete(id);
				finish(previous);
			});
		});
	}
	async restore(record: SavedScene): Promise<void> {
		const checked = validRecord(record);
		return this.transaction('readwrite', (store, finish, observe) => {
			observe(store.get(checked.id), (existing) => {
				if (existing) throw new Error('Cannot restore: a scene with this ID already exists.');
				store.put(checked);
				finish(undefined);
			});
		});
	}
}

/** Explicit in-memory adapter for deterministic tests; browser failures never silently fall back. */
export function createMemorySceneRepository(now: () => number = Date.now): SceneRepository {
	const records = new Map<string, SavedScene>();
	return {
		async list() {
			return structuredClone(
				[...records.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
			);
		},
		async get(id) {
			const record = records.get(id);
			return record ? structuredClone(record) : undefined;
		},
		async put(value, thumbnail) {
			const scene = assertScene(value);
			validThumbnail(thumbnail);
			const previous = records.get(scene.id);
			const timestamp = Math.max(now(), previous?.updatedAt ?? 0);
			const record: SavedScene = {
				id: scene.id,
				name: scene.name,
				createdAt: previous?.createdAt ?? timestamp,
				updatedAt: timestamp,
				scene,
				...(thumbnail === undefined
					? previous?.thumbnail === undefined
						? {}
						: { thumbnail: previous.thumbnail }
					: { thumbnail })
			};
			records.set(scene.id, structuredClone(record));
			return structuredClone(record);
		},
		async remove(id) {
			const previous = records.get(id);
			records.delete(id);
			return previous ? structuredClone(previous) : undefined;
		},
		async restore(record) {
			if (records.has(record.id))
				throw new Error('Cannot restore: a scene with this ID already exists.');
			records.set(record.id, structuredClone(validRecord(record)));
		}
	};
}
export const sceneRepository: SceneRepository = new IndexedDbSceneRepository();
