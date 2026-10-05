import { describe, expect, it } from 'vitest';
import { createDefaultScene } from '#lib/model';
import { createTopologyPreparer } from './topology-preparation';
import type {
	TopologyPreparationRequest,
	TopologyPreparationReply,
	TopologyPreparationWorker,
	PreparedTopology,
	TopologyMigrationRequest
} from './topology-preparation';

class WorkerHarness extends EventTarget {
	requests: TopologyPreparationRequest[] = [];
	terminated = false;
	transfers: Transferable[][] = [];
	postMessage(request: TopologyPreparationRequest, transfer: Transferable[] = []) {
		this.requests.push(request);
		this.transfers.push(transfer);
	}
	terminate() {
		this.terminated = true;
	}
	reply(data: TopologyPreparationReply) {
		this.dispatchEvent(new MessageEvent('message', { data }));
	}
	complete(id: number, value = id) {
		this.reply({ type: 'ready', id, buffer: new Float32Array([value]).buffer });
	}
	migrated(id: number) {
		this.reply({
			type: 'migrated',
			id,
			result: {
				particles: new ArrayBuffer(64),
				metrics: new Float32Array(16),
				history: new Float32Array(512),
				valid: 1
			}
		});
	}
}
const snapshot = () => ({
	particles: new ArrayBuffer(64),
	metrics: new ArrayBuffer(64),
	history: new ArrayBuffer(2048),
	head: 0,
	valid: 1,
	oldInterval: 1,
	newInterval: 0.5
});
function scene(radius = 14) {
	const definition = createDefaultScene();
	definition.world = { kind: 'surface', shape: 'trefoil', radius };
	return definition;
}
function setup() {
	const workers: WorkerHarness[] = [];
	const preparer = createTopologyPreparer(() => {
		const worker = new WorkerHarness();
		workers.push(worker);
		return worker as unknown as TopologyPreparationWorker;
	});
	return { preparer, workers };
}
const result = (promise: Promise<PreparedTopology>) =>
	promise.then(
		(data) => ({ data, error: null }),
		(error: Error) => ({ data: null, error })
	);

describe('per-engine off-thread topology preparation', () => {
	it('never supersedes a runtime migration with ordinary geometry requests and transfers its snapshot', async () => {
		const { preparer, workers } = setup();
		const old = snapshot();
		const migration = preparer.migrate([], scene(), 1, 1, old);
		const superseded = result(preparer.prepare(scene(18)));
		const latest = preparer.prepare(scene(19));
		const worker = workers[0];
		expect(worker.requests).toHaveLength(1);
		expect((worker.requests[0] as unknown as TopologyMigrationRequest).type).toBe('migrate');
		expect(worker.transfers[0]).toEqual([old.particles, old.metrics, old.history]);
		worker.migrated(1);
		expect((await migration).valid).toBe(1);
		expect(worker.requests[1].scene.world).toEqual(scene(19).world);
		worker.complete(3);
		expect((await latest).topology[0]).toBe(3);
		expect((await superseded).error?.name).toBe('AbortError');
		preparer.dispose();
	});
	it('finishes queued migrations in order before the latest preparation, and rejects migration at disposal', async () => {
		const { preparer, workers } = setup();
		const first = result(preparer.prepare(scene()));
		const migration = preparer.migrate([], scene(), 1, 1, snapshot());
		const another = preparer.migrate([], scene(), 1, 1, snapshot());
		const latest = preparer.prepare(scene(19));
		const worker = workers[0];
		worker.complete(1);
		expect(worker.requests[1].id).toBe(2);
		worker.migrated(2);
		worker.migrated(3);
		expect((await migration).valid).toBe(1);
		expect((await another).valid).toBe(1);
		worker.complete(4);
		await latest;
		expect((await first).error?.name).toBe('AbortError');
		const cancelled = preparer
			.migrate([], scene(), 1, 1, snapshot())
			.catch((error: Error) => error.name);
		preparer.dispose();
		expect(await cancelled).toBe('AbortError');
	});
	it('creates no worker for SSR construction, analytic worlds or disposal before first use', async () => {
		const { preparer, workers } = setup();
		expect(workers).toHaveLength(0);
		expect((await preparer.prepare(createDefaultScene())).topology).toHaveLength(0);
		preparer.dispose();
		expect(workers).toHaveLength(0);
		await expect(preparer.prepare(scene())).rejects.toHaveProperty('name', 'AbortError');
	});
	it('coalesces hundreds of slider changes into the active build and only the latest queued geometry', async () => {
		const { preparer, workers } = setup();
		const outcomes = [result(preparer.prepare(scene()))];
		for (let radius = 15; radius < 115; radius++)
			outcomes.push(result(preparer.prepare(scene(radius))));
		const worker = workers[0];
		expect(worker.requests).toHaveLength(1);
		worker.complete(worker.requests[0].id, 999);
		expect(worker.requests).toHaveLength(2);
		expect(worker.requests[1].scene.world).toEqual(scene(114).world);
		worker.complete(worker.requests[1].id, 114);
		const resolved = await Promise.all(outcomes);
		expect(resolved.slice(0, -1).every((entry) => entry.error?.name === 'AbortError')).toBe(true);
		expect(resolved.at(-1)!.data!.topology[0]).toBe(114);
		preparer.dispose();
	});
	it('shares identical outstanding requests and owns a snapshot of caller geometry', async () => {
		const { preparer, workers } = setup();
		const definition = scene();
		const first = preparer.prepare(definition);
		expect(preparer.prepare(definition)).toBe(first);
		definition.world = { kind: 'surface', shape: 'trefoil', radius: 40, tubeRadius: 6 };
		expect(workers[0].requests[0].scene.world).toEqual(scene().world);
		workers[0].complete(workers[0].requests[0].id);
		expect((await first).topology).toEqual(new Float32Array([1]));
		preparer.dispose();
	});
	it('prepares analytic resets off-thread and coalesces by seed, population, generation and capacity', async () => {
		const { preparer, workers } = setup();
		const definition = createDefaultScene();
		const first = result(preparer.prepare(definition, { generation: 2, capacity: 20000 }));
		definition.seed++;
		const second = result(preparer.prepare(definition, { generation: 3, capacity: 20001 }));
		expect(workers).toHaveLength(1);
		expect(workers[0].requests[0].reset).toEqual({ generation: 2, capacity: 20000 });
		expect(workers[0].requests[0].scene.seed).toBe(definition.seed - 1);
		workers[0].complete(1);
		expect(workers[0].requests[1].reset).toEqual({ generation: 3, capacity: 20001 });
		workers[0].complete(2);
		expect((await first).error?.name).toBe('AbortError');
		expect((await second).data!.topology[0]).toBe(2);
		preparer.dispose();
	});
	it('discards stale or unknown replies and rejects queued work when returning to an analytic world', async () => {
		const { preparer, workers } = setup();
		const first = result(preparer.prepare(scene()));
		const latest = result(preparer.prepare(scene(25)));
		const worker = workers[0];
		worker.complete(4000);
		expect(worker.requests).toHaveLength(1);
		const analytic = await preparer.prepare(createDefaultScene());
		expect(analytic.topology).toHaveLength(0);
		worker.complete(1);
		expect(worker.requests).toHaveLength(1);
		expect((await first).error?.name).toBe('AbortError');
		expect((await latest).error?.name).toBe('AbortError');
		preparer.dispose();
	});
	it('terminates its worker, rejects every pending caller, and ignores late delivery at teardown', async () => {
		const { preparer, workers } = setup();
		const first = result(preparer.prepare(scene()));
		const latest = result(preparer.prepare(scene(40)));
		preparer.dispose();
		const worker = workers[0];
		expect(worker.terminated).toBe(true);
		worker.complete(1);
		expect(worker.requests).toHaveLength(1);
		expect((await first).error?.name).toBe('AbortError');
		expect((await latest).error?.name).toBe('AbortError');
	});
	it('reports worker failures and creates a fresh worker for a later retry', async () => {
		const { preparer, workers } = setup();
		const first = result(preparer.prepare(scene()));
		workers[0].dispatchEvent(new Event('error'));
		expect((await first).error?.message).toContain('could not prepare');
		expect(workers[0].terminated).toBe(true);
		const retry = preparer.prepare(scene());
		workers[1].complete(workers[1].requests[0].id);
		expect((await retry).topology[0]).toBe(2);
		preparer.dispose();
	});
	it('discards superseded job errors and keeps the latest geometry runnable in the same worker', async () => {
		const { preparer, workers } = setup();
		const first = result(preparer.prepare(scene()));
		const latest = preparer.prepare(scene(20));
		workers[0].reply({ type: 'error', id: 1, message: 'Obsolete geometry failed.' });
		expect((await first).error?.name).toBe('AbortError');
		expect(workers[0].terminated).toBe(false);
		expect(workers[0].requests[1].scene.world).toEqual(scene(20).world);
		workers[0].complete(2);
		expect((await latest).topology[0]).toBe(2);
		preparer.dispose();
	});
	it('keeps independent workers and cancellation generations for separately mounted engines', async () => {
		const first = setup(),
			second = setup();
		const a = result(first.preparer.prepare(scene())),
			b = second.preparer.prepare(scene());
		first.preparer.dispose();
		second.workers[0].complete(1, 42);
		expect((await a).error?.name).toBe('AbortError');
		expect((await b).topology[0]).toBe(42);
		expect(second.workers[0].terminated).toBe(false);
		second.preparer.dispose();
	});
});
