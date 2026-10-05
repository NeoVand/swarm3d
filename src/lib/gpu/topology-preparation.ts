import { isTopologyWorld } from '#lib/model';
import type { SceneDefinition, PopulationState, AgentState } from '#lib/model';
import type { migrateRuntime } from './migration';

export interface TopologyPreparationRequest {
	type: 'prepare';
	id: number;
	scene: SceneDefinition;
	reset?: TopologyResetPreparation;
}
export type RuntimeMigrationSnapshot = Parameters<typeof migrateRuntime>[4];
export type PreparedRuntimeMigration = ReturnType<typeof migrateRuntime>;
export interface TopologyMigrationRequest {
	type: 'migrate';
	id: number;
	agents: AgentState[];
	scene: SceneDefinition;
	generation: number;
	capacity: number;
	snapshot: RuntimeMigrationSnapshot;
}
export type TopologyWorkerRequest = TopologyPreparationRequest | TopologyMigrationRequest;
export type TopologyPreparationReply =
	| {
			type: 'ready';
			id: number;
			buffer: ArrayBuffer;
			population?: PopulationState;
			particles?: ArrayBuffer;
	  }
	| { type: 'migrated'; id: number; result: PreparedRuntimeMigration }
	| { type: 'error'; id: number; message: string };

/** Minimal injectable worker contract, also used by deterministic lifecycle tests. */
export interface TopologyPreparationWorker {
	postMessage(request: TopologyWorkerRequest, transfer?: Transferable[]): void;
	addEventListener(
		type: 'message',
		listener: (event: MessageEvent<TopologyPreparationReply>) => void
	): void;
	addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
	removeEventListener(
		type: 'message',
		listener: (event: MessageEvent<TopologyPreparationReply>) => void
	): void;
	removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
	terminate(): void;
}
export interface TopologyResetPreparation {
	generation: number;
	capacity: number;
}
export interface PreparedTopology {
	topology: Float32Array<ArrayBuffer>;
	population?: PopulationState;
	particles?: ArrayBuffer;
}
export interface TopologyPreparer {
	prepare(scene: SceneDefinition, reset?: TopologyResetPreparation): Promise<PreparedTopology>;
	migrate(
		agents: AgentState[],
		scene: SceneDefinition,
		generation: number,
		capacity: number,
		snapshot: RuntimeMigrationSnapshot
	): Promise<PreparedRuntimeMigration>;
	dispose(): void;
}
interface Pending<T> {
	id: number;
	promise: Promise<T>;
	resolve(data: T): void;
	reject(error: Error): void;
	cancelled: boolean;
}
type PreparationPending = Pending<PreparedTopology> & {
	kind: 'prepare';
	key: string;
	request: TopologyPreparationRequest;
};
type MigrationPending = Pending<PreparedRuntimeMigration> & {
	kind: 'migrate';
	request: TopologyMigrationRequest;
};
type PendingJob = PreparationPending | MigrationPending;
const aborted = () =>
	new DOMException('Topology preparation was superseded or disposed.', 'AbortError');

/** Each mounted engine owns its worker. Creating the preparer is safe during
 * SSR; only its first topology or population request starts a browser module worker. */
export function createTopologyPreparer(
	workerFactory: () => TopologyPreparationWorker = () =>
		new Worker(new URL('./topology-worker.ts', import.meta.url), { type: 'module' })
): TopologyPreparer {
	let worker: TopologyPreparationWorker | null = null;
	let inFlight: PendingJob | null = null;
	let queued: PreparationPending | null = null;
	const migrations: MigrationPending[] = [];
	let sequence = 0;
	let disposed = false;
	function cancel(pending: PendingJob | null) {
		if (!pending || pending.cancelled) return;
		pending.cancelled = true;
		pending.reject(aborted());
	}
	function releaseWorker() {
		if (!worker) return;
		worker.removeEventListener('message', onMessage);
		worker.removeEventListener('error', onError);
		worker.removeEventListener('messageerror', onError);
		worker.terminate();
		worker = null;
	}
	function rejectAll(error: Error) {
		inFlight?.reject(error);
		queued?.reject(error);
		for (const migration of migrations.splice(0)) migration.reject(error);
		inFlight = queued = null;
		releaseWorker();
	}
	function onError(event: Event) {
		const message =
			'message' in event && typeof event.message === 'string'
				? event.message
				: 'The topology worker could not prepare this world.';
		rejectAll(new Error(message));
	}
	function dispatch(pending: PendingJob) {
		inFlight = pending;
		try {
			if (!worker) {
				worker = workerFactory();
				worker.addEventListener('message', onMessage);
				worker.addEventListener('error', onError);
				worker.addEventListener('messageerror', onError);
			}
			worker.postMessage(
				pending.request,
				pending.kind === 'migrate'
					? [
							pending.request.snapshot.particles,
							pending.request.snapshot.metrics,
							pending.request.snapshot.history
						]
					: []
			);
		} catch (error) {
			rejectAll(error instanceof Error ? error : new Error(String(error)));
		}
	}
	function onMessage(event: MessageEvent<TopologyPreparationReply>) {
		const reply = event.data;
		const pending = inFlight;
		if (disposed || !pending || reply.id !== pending.id) return;
		inFlight = null;
		if (!pending.cancelled) {
			if (reply.type === 'ready' && pending.kind === 'prepare')
				pending.resolve({
					topology: new Float32Array(reply.buffer),
					population: reply.population,
					particles: reply.particles
				});
			else if (reply.type === 'migrated' && pending.kind === 'migrate')
				pending.resolve(reply.result);
			else
				pending.reject(
					new Error(reply.type === 'error' ? reply.message : 'Unexpected topology worker reply.')
				);
		}
		if (migrations.length) dispatch(migrations.shift()!);
		else if (queued) {
			const next = queued;
			queued = null;
			dispatch(next);
		}
	}
	return {
		prepare(scene, reset) {
			if (disposed) return Promise.reject(aborted());
			if (!isTopologyWorld(scene.world) && !reset) {
				if (inFlight?.kind === 'prepare') cancel(inFlight);
				cancel(queued);
				queued = null;
				return Promise.resolve({ topology: new Float32Array(0) });
			}
			const key = reset
				? `${JSON.stringify(scene)}:${reset.generation}:${reset.capacity}`
				: `${JSON.stringify(scene.world)}:${scene.obstacles.length}`;
			if (queued?.key === key) return queued.promise;
			if (inFlight?.kind === 'prepare' && inFlight.key === key && !inFlight.cancelled && !queued)
				return inFlight.promise;
			if (inFlight?.kind === 'prepare') cancel(inFlight);
			cancel(queued);
			let resolve!: PreparationPending['resolve'];
			let reject!: PreparationPending['reject'];
			const promise = new Promise<PreparedTopology>((done, fail) => {
				resolve = done;
				reject = fail;
			});
			const pending: PreparationPending = {
				kind: 'prepare',
				id: ++sequence,
				key,
				promise,
				resolve,
				reject,
				cancelled: false,
				request: {
					type: 'prepare',
					id: sequence,
					scene: structuredClone(scene),
					reset: reset ? { ...reset } : undefined
				}
			};
			if (inFlight) queued = pending;
			else dispatch(pending);
			return promise;
		},
		migrate(agents, scene, generation, capacity, snapshot) {
			if (disposed) return Promise.reject(aborted());
			let resolve!: MigrationPending['resolve'];
			let reject!: MigrationPending['reject'];
			const promise = new Promise<PreparedRuntimeMigration>((done, fail) => {
				resolve = done;
				reject = fail;
			});
			const pending: MigrationPending = {
				kind: 'migrate',
				id: ++sequence,
				promise,
				resolve,
				reject,
				cancelled: false,
				request: {
					type: 'migrate',
					id: sequence,
					agents: structuredClone(agents),
					scene: structuredClone(scene),
					generation,
					capacity,
					snapshot: { ...snapshot }
				}
			};
			if (inFlight) migrations.push(pending);
			else dispatch(pending);
			return promise;
		},
		dispose() {
			disposed = true;
			cancel(inFlight);
			cancel(queued);
			for (const migration of migrations.splice(0)) cancel(migration);
			inFlight = queued = null;
			releaseWorker();
		}
	};
}
