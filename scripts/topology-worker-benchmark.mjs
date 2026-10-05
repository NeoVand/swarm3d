import { cpus, platform } from 'node:os';
import { chromium } from 'playwright';

// Start a Vite development server, then run:
// node scripts/topology-worker-benchmark.mjs http://127.0.0.1:5173
// This blank browser harness measures real module Worker transfers without
// mounting the simulation or competing with its GPU workload.
const baseURL = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	const source = await page.request.get(new URL('/src/lib/gpu/topology.ts', baseURL).href);
	if (!source.ok())
		throw new Error(
			`A Vite development server is required at ${baseURL}; source request returned ${source.status()}.`
		);
	await page.route('**/worker-harness', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><html><body>CPU worker harness</body></html>'
		})
	);
	await page.goto(new URL('/worker-harness', baseURL).href);
	const report = await page.evaluate(async () => {
		const { createTopologyPreparer } = await import('/src/lib/gpu/topology.ts');
		const { createDefaultScene } = await import('/src/lib/model/index.ts');
		const preparer = createTopologyPreparer();
		const scene = createDefaultScene();
		scene.species.forEach((species, index) => (species.population = index === 0 ? 5700 : 4700));
		const capacity = scene.species.reduce((sum, species) => sum + species.population, 0);
		let last = performance.now(),
			maxGap = 0,
			intervals = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			maxGap = Math.max(maxGap, now - last);
			last = now;
			intervals++;
		}, 10);
		const longTasks = [];
		const observer = new PerformanceObserver((entries) => {
			longTasks.push(...entries.getEntries());
		});
		observer.observe({ type: 'longtask', buffered: false });
		const results = [];
		async function measure(name, operation) {
			// Keep synthetic fixture setup outside the measured request task.
			await new Promise((resolve) => setTimeout(resolve, 0));
			last = performance.now();
			maxGap = 0;
			intervals = 0;
			const started = performance.now();
			const result = await operation();
			const finished = performance.now();
			// Give the heartbeat and observer time to see the final receive task.
			await new Promise((resolve) => setTimeout(resolve, 12));
			const tasks = longTasks.filter(
				(entry) => entry.startTime + entry.duration >= started && entry.startTime <= finished
			);
			results.push({
				name,
				ms: +(finished - started).toFixed(2),
				maxMainGapMs: +maxGap.toFixed(2),
				mainIntervals: intervals,
				mainLongTasks: tasks.length,
				maxMainTaskMs: +Math.max(0, ...tasks.map((entry) => entry.duration)).toFixed(2),
				atlasBytes: result.topology?.byteLength,
				historyBytes: result.history?.byteLength,
				population: result.population?.agents.length
			});
			return result;
		}
		try {
			scene.world = { kind: 'surface', shape: 'trefoil', radius: 14, tubeRadius: 0.84 };
			await measure('cold trefoil .06 reset', () =>
				preparer.prepare(scene, { generation: 1, capacity })
			);
			scene.world = { kind: 'surface', shape: 'trefoil', radius: 28, tubeRadius: 1.68 };
			await measure('warm uniform atlas scale', () => preparer.prepare(scene));
			scene.world = { kind: 'surface', shape: 'trefoil', radius: 14, tubeRadius: 2.24 };
			await measure('new thickness .16 reset', () =>
				preparer.prepare(scene, { generation: 2, capacity })
			);
			scene.world = {
				kind: 'volume',
				shape: 'box',
				halfExtents: [18, 12, 18],
				boundaries: 'reflect'
			};
			const reset = await measure('box reset', () =>
				preparer.prepare(scene, { generation: 3, capacity })
			);
			// A full synthetic history exercises the same 64-slot transfer and
			// resampling path as a running swarm, with valid generation tokens.
			const state = new Float32Array(reset.particles);
			const history = new Float32Array(capacity * 64 * 8);
			const colorBase = capacity * 64 * 4;
			for (let slot = 0; slot < capacity; slot++)
				for (let age = 0; age < 64; age++) {
					const offset = (slot * 64 + 63 - age) * 4;
					for (let axis = 0; axis < 3; axis++) history[offset + axis] = state[slot * 16 + axis];
					history[offset + 3] = 3;
					history.set([0.5, 0.7, 0.9, 1], colorBase + offset);
				}
			const snapshot = (newInterval) => ({
				particles: reset.particles.slice(0),
				metrics: new ArrayBuffer(capacity * 64),
				history: history.buffer.slice(0),
				head: 63,
				valid: 64,
				oldInterval: 0.05,
				newInterval
			});
			const exact = snapshot(0.05);
			await measure('box equal-interval history migration', () =>
				preparer.migrate(reset.population.agents, scene, 3, capacity, exact)
			);
			const resampled = snapshot(0.1);
			await measure('box resampled history migration', () =>
				preparer.migrate(reset.population.agents, scene, 3, capacity, resampled)
			);
			const pending = [];
			for (let index = 0; index < 10; index++) {
				scene.world = {
					kind: 'surface',
					shape: 'trefoil',
					radius: 14,
					tubeRadius: 14 * (0.06 + index * 0.001)
				};
				pending.push(
					preparer.prepare(scene).then(
						(value) => ({ ready: true, bytes: value.topology.byteLength }),
						(error) => ({ error: error.name })
					)
				);
			}
			const outcomes = await Promise.all(pending);
			const coalescing = {
				aborted: outcomes.filter((value) => value.error === 'AbortError').length,
				ready: outcomes.filter((value) => value.ready).length
			};
			if (coalescing.aborted !== 9 || coalescing.ready !== 1)
				throw new Error(`Unexpected coalescing result: ${JSON.stringify(coalescing)}`);
			return { capacity, results, coalescing };
		} finally {
			clearInterval(timer);
			observer.disconnect();
			preparer.dispose();
		}
	});
	console.log(
		JSON.stringify(
			{
				reference: { cpu: cpus()[0]?.model, platform: platform(), browser: browser.version() },
				...report
			},
			null,
			2
		)
	);
} finally {
	await browser.close();
}
