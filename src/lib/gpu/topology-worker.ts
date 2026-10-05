import { prepareTopologyJob } from './topology-preparation-job';
import type { TopologyWorkerRequest, TopologyPreparationReply } from './topology-preparation';

// Keep worker-only globals local so importing the public preparer needs no
// browser surface, GPU device, or worker during SSR and native tests.
interface WorkerScope {
	onmessage: ((event: MessageEvent<TopologyWorkerRequest>) => void) | null;
	postMessage(reply: TopologyPreparationReply, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;
scope.onmessage = ({ data }) => {
	const reply = prepareTopologyJob(data);
	// The normalized LRU remains in this worker. Only independently owned atlas
	// and particle allocations transfer into the mounted engine's ownership.
	scope.postMessage(
		reply,
		reply.type === 'ready'
			? [reply.buffer, ...(reply.particles ? [reply.particles] : [])]
			: reply.type === 'migrated'
				? [reply.result.particles, reply.result.metrics.buffer, reply.result.history.buffer]
				: []
	);
};
