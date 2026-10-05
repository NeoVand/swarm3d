import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { wgslVitePlugin } from 'vgpu/client';

// An isolated engine canvas: no Svelte application, laboratory, or concurrent cases.
// Run only when other GPU checks/applications are idle. No synthetic ticks are used.
const argumentsList = process.argv.slice(2);
const accepted = new Set([
	'--matrix',
	'--crowded',
	'--surfaces',
	'--torus',
	'--refinements',
	'--help'
]);
for (const argument of argumentsList) {
	if (!accepted.has(argument)) throw new Error(`Unknown argument: ${argument}`);
}
if (argumentsList.includes('--help')) {
	console.log(`Usage: node scripts/browser-performance.mjs [--matrix] [--crowded] [--surfaces | --torus | --refinements]

Default: 5,000 agents, both domains, Balanced/Sharp × trails on/off × bloom on/off.
--matrix: add 10,000 and 20,000 agents in both ordinary domains, Balanced/full effects.
--crowded: add 1,000 agents in compact box [3,2,3] and sphere R=4, Balanced/full effects.
--surfaces: measure only plane and cylinder at 5,000 agents, Balanced/full effects;
           combine with --matrix to add 10,000/20,000. Writes browser-surfaces.json.
--torus: measure only torus R20/r8 with local ranges, at 5k (10k/20k with --matrix).
         Writes browser-torus.json. Cannot be combined with --surfaces.
--refinements: current 5k/10k/20k box/sphere, 5k Fast/Sharp, and compact user box
               7,150 agents at requested 1x/2.7x. Writes browser-refinements.json.
New surface cases warm for 5 seconds and sample for 10 seconds.
Original cases warm for 2 seconds, then sample 6 seconds (10 seconds for added cases).
Results: .cache/performance/browser.json and both 5k Balanced/full-effects PNGs.
This starts one temporary minimal Vite server and a full Playwright Chromium browser.`);
	process.exit(0);
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = resolve(projectRoot, '.cache/performance');
const newSurfaces = argumentsList.includes('--surfaces');
const torus = argumentsList.includes('--torus');
const refinements = argumentsList.includes('--refinements');
if (refinements && argumentsList.length > 1)
	throw new Error('--refinements is a standalone audit.');
if (newSurfaces && torus) throw new Error('Choose --surfaces or --torus.');
const extraSurfaces = newSurfaces || torus;
const outputPath = resolve(
	outputDirectory,
	refinements
		? 'browser-refinements.json'
		: torus
			? 'browser-torus.json'
			: newSurfaces
				? 'browser-surfaces.json'
				: 'browser.json'
);
const viewport = { width: 1280, height: 800 };
const deviceScaleFactor = 2;
const launchArguments = ['--enable-gpu', '--enable-unsafe-webgpu'];
const packageDefinition = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
const cases = [];
for (const domain of extraSurfaces ? [] : ['volume', 'surface']) {
	for (const quality of ['balanced', 'sharp']) {
		for (const trails of [true, false]) {
			for (const bloom of [true, false]) {
				cases.push({
					id: `${domain}-5000-${quality}-trails-${Number(trails)}-bloom-${Number(bloom)}`,
					domain,
					population: 5000,
					geometry: 'ordinary',
					quality,
					trails,
					bloom,
					warmupSeconds: 2,
					sampleSeconds: 6,
					capture: quality === 'balanced' && trails && bloom
				});
			}
		}
	}
}
if (!extraSurfaces && argumentsList.includes('--matrix')) {
	for (const population of [10000, 20000]) {
		for (const domain of ['volume', 'surface']) {
			cases.push({
				id: `${domain}-${population}-balanced-full`,
				domain,
				population,
				geometry: 'ordinary',
				quality: 'balanced',
				trails: true,
				bloom: true,
				warmupSeconds: 2,
				sampleSeconds: 10,
				capture: false
			});
		}
	}
}
if (!extraSurfaces && argumentsList.includes('--crowded')) {
	for (const domain of ['volume', 'surface']) {
		cases.push({
			id: `${domain}-1000-compact-balanced-full`,
			domain,
			population: 1000,
			geometry: 'compact',
			quality: 'balanced',
			trails: true,
			bloom: true,
			warmupSeconds: 2,
			sampleSeconds: 10,
			capture: false
		});
	}
}
if (extraSurfaces) {
	for (const population of argumentsList.includes('--matrix') ? [5000, 10000, 20000] : [5000]) {
		for (const shape of torus ? ['torus'] : ['plane', 'cylinder']) {
			cases.push({
				id: `${shape}-${population}-balanced-full`,
				domain: 'surface',
				shape,
				world:
					shape === 'plane'
						? { kind: 'surface', shape, halfExtents: [18, 18], boundaries: 'reflect' }
						: shape === 'torus'
							? { kind: 'surface', shape, majorRadius: 20, tubeRadius: 8 }
							: { kind: 'surface', shape, radius: 12, halfHeight: 14 },
				population,
				geometry: 'ordinary',
				quality: 'balanced',
				trails: true,
				bloom: true,
				warmupSeconds: 5,
				sampleSeconds: 10,
				capture: population === 5000
			});
		}
	}
}

if (refinements) {
	cases.length = 0;
	const append = (domain, population, quality = 'balanced', overrides = {}) =>
		cases.push({
			id: `${domain}-${population}-${quality}-${overrides.requestedRate ?? 1}x${overrides.world ? '-compact' : ''}`,
			domain,
			population,
			geometry: overrides.world ? 'user-compact' : 'ordinary',
			quality,
			trails: true,
			bloom: true,
			warmupSeconds: 3,
			sampleSeconds: 10,
			capture: population === 5000 && quality === 'balanced',
			...overrides
		});
	for (const population of [5000, 10000, 20000])
		for (const domain of ['volume', 'surface']) append(domain, population);
	for (const quality of ['fast', 'sharp']) append('volume', 5000, quality);
	for (const requestedRate of [1, 2.7])
		append('volume', 7150, 'balanced', {
			world: { kind: 'volume', shape: 'box', halfExtents: [4.5, 8, 8.5], boundaries: 'reflect' },
			requestedRate,
			speciesPopulations: [5400, 1750]
		});
}

// Serialized into a module script served by the temporary Vite server. All GPU
// ownership stays inside createEngine, including RAF, queue pacing and disposal.
async function browserHarness() {
	const { createEngine } = await import('/src/lib/gpu/engine.ts');
	const { createDefaultScene, resizePopulation, assertScene, CURATED_SCENES } =
		await import('/src/lib/model/index.ts');
	let engine = null;
	let controller = null;
	let canvas = document.querySelector('canvas');
	let stopped = false;
	const errorText = (error) => error?.message ?? String(error);
	const replaceCanvas = () => {
		const replacement = document.createElement('canvas');
		replacement.id = 'stage';
		canvas.replaceWith(replacement);
		canvas = replacement;
	};
	const stop = () => {
		stopped = true;
		controller?.abort();
		engine?.setPaused(true);
		engine?.dispose();
		engine = null;
	};
	const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
	const describeCanvas = (quality) => {
		const bounds = canvas.getBoundingClientRect();
		const effectiveDpr = Math.max(1, Math.min(2, window.devicePixelRatio));
		const stageScale =
			quality === 'sharp' ? 1 : Math.min(1, (quality === 'fast' ? 1 : 1.25) / effectiveDpr);
		return {
			css: { width: bounds.width, height: bounds.height },
			pixels: { width: canvas.width, height: canvas.height },
			devicePixelRatio: window.devicePixelRatio,
			effectiveCanvasDpr: effectiveDpr,
			stagePixels: {
				width: Math.max(1, Math.round(canvas.width * stageScale)),
				height: Math.max(1, Math.round(canvas.height * stageScale)),
				source: 'Derived from production engine stageSize contract; not a GPU readback.'
			}
		};
	};
	window.swarmBenchmark = {
		stop,
		async environment() {
			if (!navigator.gpu) throw new Error('This Chromium session has no WebGPU API.');
			const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
			if (!adapter) throw new Error('This Chromium session has no usable WebGPU adapter.');
			const info = adapter.info;
			return {
				userAgent: navigator.userAgent,
				platform: navigator.platform,
				devicePixelRatio: window.devicePixelRatio,
				adapter: {
					vendor: info?.vendor ?? null,
					architecture: info?.architecture ?? null,
					device: info?.device ?? null,
					description: info?.description ?? null,
					isFallbackAdapter: info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
					subgroupMinSize: info?.subgroupMinSize ?? null,
					subgroupMaxSize: info?.subgroupMaxSize ?? null,
					source:
						'requestAdapter(high-performance) metadata; each case also records the engine adapter label.'
				},
				adapterFeatures: [...adapter.features],
				secureContext: window.isSecureContext
			};
		},
		async run(options) {
			if (engine || controller) throw new Error('Another benchmark case still owns the canvas.');
			stopped = false;
			controller = new AbortController();
			const initial =
				options.shape === 'torus'
					? CURATED_SCENES.find((scene) => scene.world.shape === 'torus')
					: createDefaultScene();
			if (!initial) throw new Error('The torus benchmark requires the authored torus scene.');
			const scene = resizePopulation(initial, options.population);
			scene.world =
				options.world ??
				(options.domain === 'surface'
					? { kind: 'surface', shape: 'sphere', radius: options.geometry === 'compact' ? 4 : 16 }
					: {
							kind: 'volume',
							shape: 'box',
							halfExtents: options.geometry === 'compact' ? [3, 2, 3] : [18, 12, 18],
							boundaries: 'reflect'
						});
			scene.visual.quality = options.quality;
			if (options.requestedRate !== undefined) scene.dynamics.timeScale = options.requestedRate;
			if (options.speciesPopulations)
				scene.species.forEach((species, i) => {
					species.population = options.speciesPopulations[i];
				});
			scene.visual.bloom = options.bloom;
			// Opacity is display-only. Never reduce population, trail length, or physics.
			if (!options.trails) for (const species of scene.species) species.trail.opacity = 0;
			assertScene(scene);
			const row = {
				...options,
				status: 'running',
				scene,
				geometryNote:
					options.geometry === 'compact'
						? 'Different compact domain dimensions, not a clustered initialization in the ordinary world.'
						: 'Ordinary domain dimensions; seeded default initialization.',
				errors: [],
				rawStats: [],
				screenshot: null
			};
			let initializedAt = 0;
			let previousStatsAt = null;
			let latestStats = null;
			let timeout;
			const check = () => {
				if (stopped) throw new Error('Benchmark case canceled.');
				if (row.errors.length) throw new Error(row.errors.at(-1));
			};
			const waitUntil = async (deadline) => {
				while (performance.now() < deadline) {
					check();
					await sleep(Math.min(100, deadline - performance.now()));
				}
				check();
			};
			try {
				const initializationStarted = performance.now();
				engine = await Promise.race([
					createEngine(
						canvas,
						scene,
						{
							onStats(stats) {
								const at = performance.now();
								latestStats = { ...stats };
								row.rawStats.push({
									...stats,
									atMilliseconds: at - initializedAt,
									intervalStartMilliseconds:
										previousStatsAt === null ? null : previousStatsAt - initializedAt
								});
								previousStatsAt = at;
							},
							onError(error) {
								row.errors.push(errorText(error));
							}
						},
						controller.signal
					),
					new Promise((_, reject) => {
						timeout = setTimeout(() => {
							controller?.abort();
							reject(new Error('Engine initialization exceeded 45 seconds.'));
						}, 45000);
					})
				]);
				clearTimeout(timeout);
				initializedAt = performance.now();
				row.initializationMilliseconds = initializedAt - initializationStarted;
				if (options.geometry === 'compact' || options.world) engine.fitCamera();
				check();
				await waitUntil(initializedAt + options.warmupSeconds * 1000);
				const sampleStart = performance.now();
				row.sampleStartMilliseconds = sampleStart - initializedAt;
				await waitUntil(sampleStart + options.sampleSeconds * 1000);
				const sampleEnd = performance.now();
				row.sampleEndMilliseconds = sampleEnd - initializedAt;
				row.observedSampleSeconds = (sampleEnd - sampleStart) / 1000;
				row.finalStats = latestStats;
				row.canvas = describeCanvas(options.quality);
				row.camera = engine.getCamera();
				// Retain complete callback intervals within the sample window. No
				// half-warmup interval is silently counted as a measured sample.
				row.samples = row.rawStats.filter(
					(stats) =>
						stats.intervalStartMilliseconds !== null &&
						stats.intervalStartMilliseconds >= row.sampleStartMilliseconds &&
						stats.atMilliseconds <= row.sampleEndMilliseconds
				);
				if (row.samples.length < 2) throw new Error('Fewer than two complete telemetry samples.');
				if (row.samples.some((stats) => stats.population !== options.population))
					throw new Error('Engine telemetry reported a different population.');
				if (
					row.samples.some(
						(stats) => !Number.isFinite(stats.fps) || !Number.isFinite(stats.realTimeFactor)
					)
				)
					throw new Error('Engine telemetry contains nonfinite performance values.');
				const summarize = (key) => {
					const values = row.samples.map((stats) => stats[key]);
					const duration = row.samples.reduce(
						(sum, stats) => sum + stats.atMilliseconds - stats.intervalStartMilliseconds,
						0
					);
					return {
						min: Math.min(...values),
						mean: values.reduce((sum, value) => sum + value, 0) / values.length,
						max: Math.max(...values),
						durationWeightedMean:
							row.samples.reduce(
								(sum, stats) =>
									sum + stats[key] * (stats.atMilliseconds - stats.intervalStartMilliseconds),
								0
							) / duration
					};
				};
				row.summary = {
					sampleCount: row.samples.length,
					fps: summarize('fps'),
					realTimeFactor: summarize('realTimeFactor'),
					requestedTimeScale: scene.dynamics.timeScale,
					firstTick: row.samples[0].tick,
					lastTick: row.samples.at(-1).tick,
					firstSimulationTime: row.samples[0].simulationTime,
					lastSimulationTime: row.samples.at(-1).simulationTime
				};
				engine.setPaused(true);
				if (options.capture) {
					const blob = await engine.screenshot();
					const dataUrl = await new Promise((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(reader.result);
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(blob);
					});
					row.screenshot = {
						dataUrl,
						capturedAfterWallSeconds: (performance.now() - initializedAt) / 1000,
						simulationTime: latestStats?.simulationTime ?? null,
						fullTrailHistory:
							(latestStats?.simulationTime ?? 0) >=
							Math.max(...scene.species.map((species) => species.trail.length))
					};
				}
				check();
				row.status = 'passed';
			} catch (error) {
				const message = errorText(error);
				if (!row.errors.includes(message)) row.errors.push(message);
				row.status = 'failed';
			} finally {
				clearTimeout(timeout);
				controller.abort();
				engine?.setPaused(true);
				engine?.dispose();
				engine = null;
				controller = null;
				replaceCanvas();
			}
			return row;
		}
	};
}

const results = {
	recordedAt: new Date().toISOString(),
	vgpu: packageDefinition.dependencies.vgpu,
	node: process.version,
	configuration: {
		viewport,
		deviceScaleFactor,
		channel: 'chromium',
		headless: true,
		launchArguments
	},
	method:
		'Isolated production engine in full Chromium, without Svelte UI. Serial cases, elapsed-wall-time warmup/sample, callback FPS and achieved simulation/wall-time factor. Effects comparisons alter only quality, bloom, and trail opacity. Complete telemetry intervals are retained; statistics are not synthetic tick timings.',
	plannedCases: cases,
	cases: [],
	errors: []
};
await mkdir(outputDirectory, { recursive: true });
const persist = () => writeFile(outputPath, JSON.stringify(results, null, 2) + '\n');
let vite;
let browser;
let page;
let activeErrors = null;
const interrupted = () => {
	results.errors.push('Benchmark interrupted by SIGINT.');
	void browser?.close();
};
process.once('SIGINT', interrupted);
try {
	vite = await createServer({
		configFile: false,
		root: projectRoot,
		appType: 'custom',
		logLevel: 'warn',
		plugins: [wgslVitePlugin()],
		resolve: { alias: { '#lib': resolve(projectRoot, 'src/lib') } },
		server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }
	});
	vite.middlewares.use((request, response, next) => {
		if (request.url !== '/benchmark.html') return next();
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Swarm engine benchmark</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#080e12}canvas{display:block;width:100vw;height:100vh}</style>
</head><body><canvas id="stage"></canvas><script type="module">(${browserHarness.toString()})();</script></body></html>`);
	});
	await vite.listen();
	const address = vite.httpServer.address();
	if (!address || typeof address === 'string')
		throw new Error('Temporary Vite server has no TCP port.');
	browser = await chromium.launch({ channel: 'chromium', headless: true, args: launchArguments });
	results.browserVersion = browser.version();
	const context = await browser.newContext({ viewport, deviceScaleFactor });
	page = await context.newPage();
	page.on('pageerror', (error) => (activeErrors ?? results.errors).push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') (activeErrors ?? results.errors).push(message.text());
	});
	await page.goto(`http://127.0.0.1:${address.port}/benchmark.html`);
	await page.waitForFunction(() => Boolean(window.swarmBenchmark), undefined, { timeout: 45000 });
	results.environment = await page.evaluate(() => window.swarmBenchmark.environment());
	if (results.errors.length) throw new Error(results.errors.at(-1));
	await persist();
	for (const configuration of cases) {
		activeErrors = [];
		console.log(
			`CASE ${configuration.id}: ${configuration.warmupSeconds}s warmup + ${configuration.sampleSeconds}s sample`
		);
		let row;
		try {
			row = await page.evaluate((options) => window.swarmBenchmark.run(options), configuration);
		} catch (error) {
			row = {
				...configuration,
				status: 'failed',
				errors: [error instanceof Error ? error.message : String(error)],
				rawStats: [],
				screenshot: null
			};
		}
		row.errors.push(...activeErrors);
		activeErrors = null;
		if (row.errors.length) row.status = 'failed';
		if (row.screenshot?.dataUrl) {
			const filename = `browser-${row.shape ?? row.domain}-5000-balanced.png`;
			await writeFile(
				resolve(outputDirectory, filename),
				Buffer.from(row.screenshot.dataUrl.split(',')[1], 'base64')
			);
			delete row.screenshot.dataUrl;
			row.screenshot.path = `.cache/performance/${filename}`;
		}
		results.cases.push(row);
		await persist();
		if (row.status === 'failed') throw new Error(`${row.id}: ${row.errors.join('; ')}`);
		console.log(
			`RESULT ${row.id}: FPS mean ${row.summary.fps.mean.toFixed(2)}, min ${row.summary.fps.min.toFixed(2)}; achieved × mean ${row.summary.realTimeFactor.mean.toFixed(3)}, min ${row.summary.realTimeFactor.min.toFixed(3)}`
		);
	}
	console.log(`Saved ${outputPath} and 5k Balanced canvas captures.`);
} catch (error) {
	results.errors.push(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
	console.error(results.errors.at(-1));
} finally {
	process.removeListener('SIGINT', interrupted);
	if (page && !page.isClosed()) {
		await page.evaluate(() => window.swarmBenchmark?.stop()).catch(() => {});
	}
	for (const close of [() => browser?.close(), () => vite?.close()]) {
		try {
			await close();
		} catch (error) {
			results.errors.push(`Cleanup: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
	results.completedAt = new Date().toISOString();
	await persist();
}
