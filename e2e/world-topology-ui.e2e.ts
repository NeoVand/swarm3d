import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import type { SceneDefinition, WorldDefinition } from '#lib/model';
import fixture from './scene.json' with { type: 'json' };

function interiorStagePixels(page: Page) {
	// Leave the header, laboratory, and lower tool dock outside render comparisons.
	const viewport = page.viewportSize()!;
	return page.screenshot({
		clip: {
			x: 24,
			y: 120,
			width: viewport.width - 380,
			height: Math.min(720, viewport.height - 240)
		}
	});
}

async function openLaboratory(page: Page) {
	const scene = structuredClone(fixture) as unknown as SceneDefinition;
	scene.world = { kind: 'surface', shape: 'sphere', radius: 14 };
	scene.dynamics.timeScale = 0.01;
	scene.visual.showBoundary = true;
	scene.visual.showGrid = true;
	for (const species of scene.species) {
		species.population = 24;
		species.trail.length = 0;
	}
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
	const pause = page.getByRole('button', { name: 'Pause simulation', exact: true });
	await expect(pause).toBeEnabled({ timeout: 45000 });
	await pause.click();
	await page.getByRole('button', { name: 'World', exact: true }).click();
}

async function exportSettings(page: Page): Promise<SceneDefinition> {
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const scene = JSON.parse(
		await readFile((await (await download).path())!, 'utf8')
	) as SceneDefinition;
	await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	return scene;
}

test('eight graphical surface choices occupy two rows and preserve editable topology scenes', async ({
	page
}, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await openLaboratory(page);
	const choices = page.getByRole('group', { name: 'World shape', exact: true });
	const buttons = choices.getByRole('button');
	await expect(buttons).toHaveCount(8);
	const boxes = await buttons.evaluateAll((elements) =>
		elements.map((element) => {
			const rect = element.getBoundingClientRect();
			return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
		})
	);
	expect(new Set(boxes.map((box) => box.top)).size).toBe(2);
	expect(new Set(boxes.map((box) => box.left)).size).toBe(4);
	for (const box of boxes) expect(box.height).toBeLessThan(60);
	await page.setViewportSize({ width: 1000, height: 800 });
	const narrow = await buttons.evaluateAll((elements) =>
		elements.map((element) => {
			const rect = element.getBoundingClientRect();
			return {
				top: rect.top,
				left: rect.left,
				right: rect.right,
				bottom: rect.bottom,
				scroll: element.scrollWidth,
				width: element.clientWidth
			};
		})
	);
	expect(new Set(narrow.map((box) => box.top)).size).toBe(2);
	expect(new Set(narrow.map((box) => box.left)).size).toBe(4);
	for (const box of narrow) {
		expect(box.left).toBeGreaterThanOrEqual(0);
		expect(box.right).toBeLessThanOrEqual(1000);
		expect(box.bottom).toBeLessThanOrEqual(800);
		expect(box.scroll).toBeLessThanOrEqual(box.width);
	}
	await page.screenshot({ path: testInfo.outputPath('surface-selector-narrow.png') });
	await page.setViewportSize({ width: 1440, height: 1000 });
	let previousCanvas = await interiorStagePixels(page);
	for (const [shape, label] of [
		['mobius', 'Möbius strip'],
		['klein', 'Klein bottle'],
		['projective', 'Projective plane'],
		['trefoil', 'Trefoil knot']
	] as const) {
		const choice = choices.getByRole('button', { name: `${label} world`, exact: true });
		await choice.click();
		await expect(choice).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.stage-domain-label')).toContainText(label.toLowerCase(), {
			ignoreCase: true
		});
		const scaleLabel = shape === 'trefoil' ? 'Knot size' : 'Surface scale';
		const scale = page.getByRole('spinbutton', { name: `${scaleLabel} value`, exact: true });
		await scale.fill('19');
		await scale.press('Enter');
		await expect(page.getByRole('slider', { name: scaleLabel, exact: true })).toHaveValue('19');
		const exported = await exportSettings(page);
		expect(exported.world).toEqual({
			kind: 'surface',
			shape,
			radius: 19,
			...(shape === 'trefoil' ? { tubeRadius: 19 * 0.15 } : {})
		});
		await expect
			.poll(async () => Buffer.compare(previousCanvas, await interiorStagePixels(page)))
			.not.toBe(0);
		previousCanvas = await interiorStagePixels(page);
		await page.screenshot({ path: testInfo.outputPath(`${shape}-world.png`) });
		await page.locator('.world-reference > summary[aria-label="World geometry guide"]').click();
		await expect(page.locator('.surface-diagram > svg')).toHaveAccessibleName(/.+/);
		if (shape === 'klein') await expect(page.locator('.world-reference')).toContainText('Dickson');
		if (shape === 'trefoil') {
			await expect(page.locator('.world-reference')).toContainText('Both angles wrap');
			await expect(page.locator('.world-reference')).toContainText('closed and orientable');
		}
		await page.locator('.world-reference > summary[aria-label="World geometry guide"]').click();
	}
	await page.screenshot({ path: testInfo.outputPath('eight-surface-worlds.png') });
	await page
		.getByRole('group', { name: 'Simulation domain' })
		.getByRole('button', { name: 'Volume', exact: true })
		.click();
	await expect(buttons).toHaveCount(4);
	await expect(choices.getByRole('button', { name: 'Sphere world', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	expect(errors).toEqual([]);
});

test('trefoil tube radius previews live, scales proportionally, and survives a scene reload', async ({
	page
}, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await openLaboratory(page);
	await page.getByRole('button', { name: 'Trefoil knot world', exact: true }).click();
	const initialCamera = (await exportSettings(page)).camera;
	expect(initialCamera.yaw).toBe(0.2);
	expect(initialCamera.pitch).toBe(0.12);
	await page.mouse.move(550, 480);
	await page.mouse.down();
	await page.mouse.move(585, 465, { steps: 6 });
	await page.mouse.up();
	await page.mouse.move(550, 480);
	await page.mouse.down({ button: 'right' });
	await page.mouse.move(580, 500);
	await page.mouse.up({ button: 'right' });
	const manualCamera = (await exportSettings(page)).camera;
	expect(manualCamera.yaw).not.toBe(initialCamera.yaw);
	expect(manualCamera.pan).not.toEqual(initialCamera.pan);
	const size = page.getByRole('spinbutton', { name: 'Knot size value', exact: true });
	const tube = page.getByRole('slider', { name: 'Tube radius', exact: true });
	const tubeNumber = page.getByRole('spinbutton', { name: 'Tube radius value', exact: true });
	await expect(size).toHaveValue('14');
	await expect(tubeNumber).toHaveValue('2.1');
	await expect(tube).toHaveAttribute('min', String(14 * 0.04));
	await expect(tube).toHaveAttribute('max', String(14 * 0.16));
	const before = await interiorStagePixels(page);
	// A range input must reshape the rendered world while the gesture is still open.
	await tube.evaluate((element) => {
		const input = element as HTMLInputElement;
		input.value = '1.4';
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await expect(tubeNumber).toHaveValue('1.4');
	await expect
		.poll(async () => Buffer.compare(before, await interiorStagePixels(page)))
		.not.toBe(0);
	await size.fill('20');
	await size.press('Enter');
	await expect(size).toHaveValue('20');
	await expect(tubeNumber).toHaveValue('2');
	await expect(tube).toHaveAttribute('min', String(20 * 0.04));
	await expect(tube).toHaveAttribute('max', String(20 * 0.16));
	await tubeNumber.fill('1.6');
	await tubeNumber.press('Enter');
	await expect(tubeNumber).toHaveValue('1.6');
	const exported = await exportSettings(page);
	expect(exported.world).toEqual({
		kind: 'surface',
		shape: 'trefoil',
		radius: 20,
		tubeRadius: 1.6
	});
	expect(exported.camera).toEqual(manualCamera);
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(exported)).toString('base64url'));
	await page.reload();
	const pause = page.getByRole('button', { name: 'Pause simulation', exact: true });
	await expect(pause).toBeEnabled({ timeout: 45000 });
	await pause.click();
	await page.getByRole('button', { name: 'World', exact: true }).click();
	await expect(size).toHaveValue('20');
	await expect(tubeNumber).toHaveValue('1.6');
	await expect(tube).toHaveValue('1.6');
	const reloaded = await exportSettings(page);
	expect(reloaded.world).toEqual(exported.world);
	expect(reloaded.camera).toEqual(manualCamera);
	await page.getByRole('button', { name: 'Fit camera to world', exact: true }).click();
	const fitted = (await exportSettings(page)).camera;
	expect(fitted.yaw).toBe(manualCamera.yaw);
	expect(fitted.pitch).toBe(manualCamera.pitch);
	await page.locator('canvas').focus();
	await page.keyboard.press('c');
	const reset = (await exportSettings(page)).camera;
	expect(reset.yaw).toBe(0.2);
	expect(reset.pitch).toBe(0.12);
	await page.screenshot({ path: testInfo.outputPath('trefoil-radius-controls.png') });
	expect(errors).toEqual([]);
});

async function responsiveInputs(page: Page, label: string, values: number[]) {
	const slider = page.getByRole('slider', { name: label, exact: true });
	await expect(slider).toBeVisible();
	return await slider.evaluate(async (element, samples) => {
		const input = element as HTMLInputElement;
		const frameGaps: number[] = [],
			inputDurations: number[] = [],
			ticks: number[] = [];
		const clock = document.querySelector<HTMLElement>('.status-measures [data-tick]');
		let previous = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
		const initialTick = Number(clock?.dataset.tick ?? 0);
		for (const value of samples) {
			const start = performance.now();
			input.value = String(value);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			inputDurations.push(performance.now() - start);
			// Keep the gesture open across two 500 ms telemetry reports. Input remains
			// tied to frames, and every intermediate frame participates in the gap check.
			const sampleStarted = previous;
			do {
				const now = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
				frameGaps.push(now - previous);
				previous = now;
				ticks.push(Number(clock?.dataset.tick ?? 0));
			} while (previous - sampleStarted < 50);
		}
		input.dispatchEvent(new Event('change', { bubbles: true }));
		return {
			initialTick,
			ticks,
			maxFrameGap: Math.max(...frameGaps),
			maxInputDuration: Math.max(...inputDurations),
			finalValue: Number(input.value),
			inputCount: samples.length,
			frames: frameGaps.length,
			positiveTickProgress: ticks.reduce(
				(total, tick, index) =>
					total + Math.max(0, tick - (index === 0 ? initialTick : ticks[index - 1])),
				0
			)
		};
	}, values);
}

for (const [world, label, from, to] of [
	[
		{ kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' },
		'Width',
		36,
		42
	],
	[{ kind: 'volume', shape: 'sphere', radius: 14 }, 'Sphere radius', 14, 18],
	[{ kind: 'volume', shape: 'torus', majorRadius: 20, tubeRadius: 8 }, 'Major radius', 20, 25],
	[{ kind: 'surface', shape: 'trefoil', radius: 14, tubeRadius: 2.1 }, 'Tube radius', 2.1, 1.4]
] satisfies [WorldDefinition, string, number, number][]) {
	test(`${world.shape}: 10,400-agent world inputs keep animation frames alive and retain the final setting`, async ({
		page
	}, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		const scene = structuredClone(fixture) as unknown as SceneDefinition;
		scene.world = world;
		scene.dynamics.timeScale = 1;
		scene.camera = {
			...scene.camera,
			yaw: world.shape === 'trefoil' ? 0.2 : 0.6,
			pitch: world.shape === 'trefoil' ? 0.12 : 0.3
		};
		scene.visual.showBoundary = true;
		scene.visual.showGrid = false;
		scene.visual.bloom = false;
		for (const [index, species] of scene.species.entries()) {
			species.population = index === 0 ? 5700 : 4700;
			species.trail.length = 0;
			if (world.shape === 'trefoil') {
				species.size = 0.07;
				species.perception = 0.5;
			}
		}
		if (world.shape === 'trefoil') scene.forces.radius = 0.5;
		await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
		await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
			timeout: 45000
		});
		const clock = page.locator('.status-measures [data-tick]');
		await expect.poll(async () => Number(await clock.getAttribute('data-tick'))).toBeGreaterThan(5);
		await page.getByRole('button', { name: 'World', exact: true }).click();
		const values = Array.from({ length: 20 }, (_, index) =>
			Number((from + ((to - from) * index) / 19).toFixed(world.shape === 'trefoil' ? 2 : 1))
		);
		const worldTiming = await responsiveInputs(page, label, values);
		expect(worldTiming.inputCount).toBe(20);
		expect(worldTiming.frames).toBeGreaterThanOrEqual(20);
		expect(worldTiming.maxFrameGap).toBeLessThan(100);
		expect(worldTiming.maxInputDuration).toBeLessThan(100);
		expect(worldTiming.finalValue).toBe(to);
		expect(worldTiming.positiveTickProgress).toBeGreaterThan(0);
		const saved = await exportSettings(page);
		expect(saved.species.reduce((total, species) => total + species.population, 0)).toBe(10400);
		if (saved.world.shape === 'box') expect(saved.world.halfExtents[0]).toBe(21);
		if (saved.world.shape === 'sphere') expect(saved.world.radius).toBe(18);
		if (saved.world.shape === 'torus') expect(saved.world.majorRadius).toBe(25);
		if (saved.world.shape === 'trefoil') expect(saved.world.tubeRadius).toBe(1.4);
		const timing: Record<string, unknown> = { world: worldTiming };
		if (world.shape === 'sphere') {
			await page.getByRole('button', { name: 'Flocking', exact: true }).click();
			const speedTiming = await responsiveInputs(
				page,
				'Speed limit',
				Array.from({ length: 20 }, (_, index) => 3.7 + index * 0.1)
			);
			expect(speedTiming.maxFrameGap).toBeLessThan(100);
			expect(Math.max(...speedTiming.ticks)).toBeGreaterThan(speedTiming.initialTick);
			await page.getByRole('button', { name: 'Appearance', exact: true }).click();
			const appearanceTiming = await responsiveInputs(
				page,
				'Exposure',
				Array.from({ length: 20 }, (_, index) => Number((1 + index * 0.05).toFixed(2)))
			);
			expect(appearanceTiming.maxFrameGap).toBeLessThan(100);
			expect(Math.max(...appearanceTiming.ticks)).toBeGreaterThan(appearanceTiming.initialTick);
			const final = await exportSettings(page);
			expect(final.species[0].speed).toBeCloseTo(5.6, 6);
			expect(final.visual.exposure).toBe(1.95);
			timing.speed = speedTiming;
			timing.appearance = appearanceTiming;
		}
		const timingPath = testInfo.outputPath('drag-responsiveness.json');
		await writeFile(timingPath, JSON.stringify(timing, null, 2));
		await testInfo.attach('drag-responsiveness.json', {
			path: timingPath,
			contentType: 'application/json'
		});
		expect(errors).toEqual([]);
	});
}

test('10,400-agent trail and population edits remain responsive, preserve selection and camera, and settle on the latest values', async ({
	page
}, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	const scene = structuredClone(fixture) as unknown as SceneDefinition;
	scene.world = { kind: 'volume', shape: 'sphere', radius: 14 };
	scene.dynamics.timeScale = 1;
	scene.visual.showBoundary = false;
	scene.visual.showGrid = false;
	scene.visual.bloom = false;
	for (const [index, species] of scene.species.entries()) {
		species.population = index === 0 ? 5700 : 4700;
		species.trail.length = 0;
	}
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
	const pause = page.getByRole('button', { name: 'Pause simulation', exact: true });
	await expect(pause).toBeEnabled({ timeout: 45000 });
	const clock = page.locator('.status-measures [data-tick]');
	await expect.poll(async () => Number(await clock.getAttribute('data-tick'))).toBeGreaterThan(5);
	await pause.click();
	await page.locator('canvas').focus();
	await page.keyboard.press('ArrowLeft');
	await page.mouse.move(550, 480);
	await page.mouse.down({ button: 'right' });
	await page.mouse.move(570, 490);
	await page.mouse.up({ button: 'right' });
	const camera = (await exportSettings(page)).camera;
	await page.getByRole('button', { name: 'Inspect', exact: true }).click();
	const inspector = page.getByLabel('Selected agent inspector');
	for (const point of [
		{ x: 640, y: 480 },
		{ x: 580, y: 480 },
		{ x: 700, y: 480 },
		{ x: 640, y: 420 },
		{ x: 640, y: 540 }
	]) {
		await page.locator('canvas').click({ position: point });
		try {
			await expect(inspector).toBeVisible({ timeout: 1000 });
			break;
		} catch {
			// Probe another part of the dense rendered volume when a ray misses a body.
		}
	}
	await expect(inspector).toBeVisible();
	const identity = await inspector.locator('h2').innerText();
	const initialTick = Number(await inspector.getAttribute('data-latest-tick'));
	await page.getByRole('button', { name: 'Resume simulation', exact: true }).click();
	await page.getByRole('button', { name: 'Appearance', exact: true }).click();
	await page
		.locator('.control-group > summary')
		.filter({ hasText: /^Trails$/ })
		.click();
	const trails = await responsiveInputs(
		page,
		'History',
		Array.from({ length: 20 }, (_, index) => Number((index * 0.1).toFixed(1)))
	);
	expect(trails.maxFrameGap).toBeLessThan(100);
	expect(trails.maxInputDuration).toBeLessThan(100);
	await page.getByRole('button', { name: 'Species', exact: true }).click();
	const population = await responsiveInputs(
		page,
		'Population',
		Array.from({ length: 20 }, (_, index) => 5700 + index * 100)
	);
	expect(population.maxFrameGap).toBeLessThan(100);
	expect(population.maxInputDuration).toBeLessThan(100);
	await expect(page.locator('.status-strip > div:first-child > b')).toHaveText('12,300');
	await expect(inspector.locator('h2')).toHaveText(identity);
	await expect
		.poll(async () => Number(await inspector.getAttribute('data-latest-tick')))
		.toBeGreaterThan(initialTick);
	const motion = await inspector.locator('.motion-figure svg').getAttribute('aria-label');
	expect(motion).not.toMatch(/NaN|Infinity|—/);
	for (const path of await inspector
		.locator('.motion-figure svg path')
		.evaluateAll((paths) => paths.map((path) => path.getAttribute('d'))))
		expect(path).not.toMatch(/NaN|Infinity/);
	const exported = await exportSettings(page);
	expect(exported.camera).toEqual(camera);
	expect(exported.species[0].population).toBe(7600);
	expect(exported.species[0].trail.length).toBe(1.9);
	expect(exported.species[1].population).toBe(4700);
	// Exclude the left inspector as well as the header, right laboratory and dock.
	const viewport = page.viewportSize()!;
	const stage = await page.screenshot({
		clip: {
			x: 360,
			y: 120,
			width: viewport.width - 740,
			height: Math.min(720, viewport.height - 240)
		}
	});
	await writeFile(testInfo.outputPath('migration-render.png'), stage);
	await testInfo.attach('migration-render.png', { body: stage, contentType: 'image/png' });
	const visibleColors = await page.evaluate(async (png) => {
		const bitmap = await createImageBitmap(
			await (await fetch(`data:image/png;base64,${png}`)).blob()
		);
		const image = document.createElement('canvas');
		image.width = bitmap.width;
		image.height = bitmap.height;
		const context = image.getContext('2d')!;
		context.drawImage(bitmap, 0, 0);
		const pixels = context.getImageData(0, 0, image.width, image.height).data;
		const colors = new Set<number>();
		for (let index = 0; index < pixels.length; index += 4)
			colors.add((pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2]);
		bitmap.close();
		return colors.size;
	}, stage.toString('base64'));
	expect(visibleColors).toBeGreaterThan(100);
	const timingPath = testInfo.outputPath('migration-responsiveness.json');
	await writeFile(timingPath, JSON.stringify({ trails, population, visibleColors }, null, 2));
	await testInfo.attach('migration-responsiveness.json', {
		path: timingPath,
		contentType: 'application/json'
	});
	expect(errors).toEqual([]);
});
