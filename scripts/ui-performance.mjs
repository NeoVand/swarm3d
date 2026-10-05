import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright';

// Build first. Run serially after other GPU tests. Samples are rounded UI values.
const newSurfaces = process.argv.slice(2).includes('--surfaces');
const torus = process.argv.slice(2).includes('--torus');
const captureOnly = process.argv.slice(2).includes('--captures');
if (
	(newSurfaces && torus) ||
	process.argv
		.slice(2)
		.some((argument) => !['--surfaces', '--torus', '--captures'].includes(argument))
)
	throw new Error('Usage: node scripts/ui-performance.mjs [--surfaces | --torus] [--captures]');
const server = await preview({ preview: { host: '127.0.0.1', port: 4185, strictPort: true } });
let browser;
const results = {
	recordedAt: new Date().toISOString(),
	method: captureOnly
		? 'Production screenshot proofs, Chromium, 1280×800 CSS/DPR2; 5s warmup, one live telemetry snapshot per world. Movement while running and independent color controls while paused; no performance benchmark.'
		: 'Production Svelte application, Chromium, 1280×800 CSS/DPR2; 5s warmup and 15s sampling, one sample per second from visible UI telemetry. Compact movement panel during sampling; independent color controls in the paused capture.',
	cases: []
};
try {
	await mkdir('.cache/performance', { recursive: true });
	browser = await chromium.launch({
		channel: 'chromium',
		args: ['--enable-gpu', '--enable-unsafe-webgpu']
	});
	results.browserVersion = browser.version();
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		deviceScaleFactor: 2
	});
	const page = await context.newPage();
	const openSection = async (name) => {
		const heading = page.getByRole('button', { name, exact: true });
		if ((await heading.getAttribute('aria-expanded')) !== 'true') await heading.click();
		await page.locator('.lab-scroll').evaluate((element) => (element.scrollTop = 0));
	};
	const dismissNotification = async () => {
		const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
		if (await dismiss.isVisible()) await dismiss.click();
	};
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await page.goto('http://127.0.0.1:4185/');
	await page.getByRole('button', { name: 'Pause simulation', exact: true }).waitFor();
	await page.waitForFunction(
		() => document.querySelector('button[aria-label="Pause simulation"]')?.disabled === false
	);
	const welcome = page.getByRole('button', { name: 'Dismiss welcome', exact: true });
	if (await welcome.isVisible()) await welcome.click();
	if (torus) {
		await page.getByRole('button', { name: 'Scenes', exact: true }).click();
		await page.getByRole('button', { name: 'Explore', exact: true }).click();
		await page.getByRole('button', { name: 'Load Ring Currents', exact: true }).click();
		await openSection('World');
	} else if (newSurfaces) {
		await page.getByRole('button', { name: 'Surface', exact: true }).click();
		await openSection('World');
	}
	const domains = torus ? ['torus'] : newSurfaces ? ['plane', 'cylinder'] : ['volume', 'surface'];
	for (const domain of domains) {
		if (newSurfaces) {
			await openSection('World');
			await page.getByRole('combobox', { name: 'Surface shape', exact: true }).selectOption(domain);
		}
		if (domain === 'surface')
			await page.getByRole('button', { name: 'Surface', exact: true }).click();
		await openSection('Flocking');
		await page.waitForTimeout(5000);
		const panel = await page.locator('.laboratory').boundingBox();
		assert.ok(panel && panel.width <= 280 && panel.x > 900, 'Compact right-hand panel');
		const samples = [];
		for (let i = 0; i < (captureOnly ? 1 : 15); i++) {
			if (!captureOnly) await page.waitForTimeout(1000);
			samples.push(
				await page.evaluate(() => ({
					fps: Number(
						document.querySelector('.status-measures > span:nth-child(2) > b').textContent
					),
					rate: Number(
						document.querySelector('.status-measures > span[data-time-scale] > b').textContent
					),
					requestedRate: Number(
						document.querySelector('.status-measures > span[data-time-scale]').dataset.timeScale
					),
					tick: Number(
						document.querySelector('.status-measures > span[data-tick]').getAttribute('data-tick')
					),
					population: Number(
						document
							.querySelector('.status-strip > div:first-child > b')
							.textContent.replace(/\D/g, '')
					)
				}))
			);
		}
		assert.ok(
			samples.every((sample) => sample.population === 5000),
			'Default population must stay 5k'
		);
		assert.ok(
			samples.every(
				(sample) => sample.fps > 0 && Number.isFinite(sample.rate) && sample.requestedRate > 0
			),
			'Finite live UI statistics'
		);
		const mean = (key) => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
		const row = {
			domain,
			population: 5000,
			panel,
			requestedRate: samples[0].requestedRate,
			runningCapture: `ui-${domain}-5000-running.png`,
			pausedCapture: `ui-${domain}-5000.png`,
			...(captureOnly
				? { status: samples[0] }
				: {
						samples,
						meanFps: mean('fps'),
						meanRate: mean('rate'),
						minFps: Math.min(...samples.map((s) => s.fps)),
						minRate: Math.min(...samples.map((s) => s.rate))
					})
		};
		results.cases.push(row);
		console.log(JSON.stringify(row));
		await dismissNotification();
		await page.screenshot({ path: `.cache/performance/ui-${domain}-5000-running.png` });
		await page.getByRole('button', { name: 'Pause simulation', exact: true }).click();
		await page.waitForFunction(
			() =>
				document.querySelector('.status-measures > span[data-time-scale] > b').textContent ===
				'0.00'
		);
		await openSection('Appearance');
		for (const channel of ['Hue', 'Saturation', 'Lightness'])
			assert.ok(
				await page.getByRole('combobox', { name: `${channel} source`, exact: true }).isVisible(),
				`${channel} mapping is visible in the compact appearance panel`
			);
		const frozenTick = await page.locator('[data-tick]').getAttribute('data-tick');
		await page.waitForTimeout(250);
		assert.equal(await page.locator('[data-tick]').getAttribute('data-tick'), frozenTick);
		await page.screenshot({ path: `.cache/performance/ui-${domain}-5000.png` });
		if (domain !== domains.at(-1))
			await page.getByRole('button', { name: 'Resume simulation', exact: true }).click();
	}
	if (!torus && !newSurfaces) {
		await page.getByRole('button', { name: 'Scenes', exact: true }).click();
		await page.getByRole('button', { name: 'Explore', exact: true }).click();
		await page.getByRole('button', { name: 'Load Chromatic Flow', exact: true }).click();
		await dismissNotification();
		await openSection('Appearance');
		const channels = {
			Hue: 'heading-azimuth',
			Saturation: 'polarization',
			Lightness: 'turn-rate'
		};
		for (const [channel, source] of Object.entries(channels)) {
			assert.equal(
				await page.getByRole('combobox', { name: `${channel} source`, exact: true }).inputValue(),
				source
			);
			assert.ok(
				await page
					.getByRole('checkbox', { name: `Enable ${channel.toLowerCase()} mapping`, exact: true })
					.isChecked()
			);
		}
		await page.getByRole('button', { name: 'Resume simulation', exact: true }).click();
		await page.waitForTimeout(5000);
		await page.screenshot({ path: '.cache/performance/ui-chromatic-flow-5000-running.png' });
		await page.getByRole('button', { name: 'Pause simulation', exact: true }).click();
		await page.waitForFunction(
			() =>
				document.querySelector('.status-measures > span[data-time-scale] > b').textContent ===
				'0.00'
		);
		await page.screenshot({ path: '.cache/performance/ui-chromatic-flow-5000.png' });
		results.presentation = {
			scene: 'Chromatic Flow',
			channels,
			runningCapture: 'ui-chromatic-flow-5000-running.png',
			pausedCapture: 'ui-chromatic-flow-5000.png'
		};
	}
	assert.deepEqual(errors, [], 'Production page errors');
} finally {
	await browser?.close();
	await new Promise((resolve, reject) =>
		server.httpServer.close((error) => (error ? reject(error) : resolve()))
	);
	results.completedAt = new Date().toISOString();
	await writeFile(
		`.cache/performance/${torus ? 'ui-torus' : newSurfaces ? 'ui-surfaces' : 'ui'}${captureOnly ? '-captures' : ''}.json`,
		JSON.stringify(results, null, 2) + '\n'
	);
}
