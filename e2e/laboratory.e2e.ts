import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import type { SceneDefinition, Vec3, WorldDefinition } from '#lib/model';
import { initializePopulation } from '../src/lib/model/population';
import {
	localFrame,
	worldDistance,
	worldExp,
	worldInteractionLimit,
	worldNormal
} from '../src/lib/model/geometry';
import { StageCamera } from '../src/lib/gpu/camera';
import fixture from './scene.json' with { type: 'json' };

function sceneUrl(surface = false) {
	const scene = structuredClone(fixture);
	if (surface)
		scene.world = { kind: 'surface', shape: 'sphere', radius: 16 } as unknown as typeof scene.world;
	return '/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url');
}
async function openWorld(page: Page, surface = false) {
	await page.goto('about:blank');
	await page.goto(sceneUrl(surface));
	await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
		timeout: 45000
	});
	await expect(page.locator('.status-strip')).toContainText('160');
}
async function openSection(page: Page, name: string) {
	const heading = page.getByRole('button', { name, exact: true });
	if ((await heading.getAttribute('aria-expanded')) !== 'true') await heading.click();
}

async function selectChoice(page: Page, control: Locator, choice: string | { label: string }) {
	await control.click();
	const menu = page.getByRole('listbox', {
		name: (await control.getAttribute('aria-label'))!,
		exact: true
	});
	await expect(menu).toBeVisible();
	if (typeof choice === 'string') {
		await menu.locator('[role="option"][data-value=' + JSON.stringify(choice) + ']').click();
		await expect(control).toHaveAttribute('data-value', choice);
	} else {
		await menu.getByRole('option', { name: choice.label, exact: true }).click();
		if ((await control.getAttribute('aria-label')) === 'Curve preset') {
			// Presets apply an action, then return to the picker prompt. Curve/pixel
			// assertions below verify the resulting mapping rather than a sticky label.
			await expect(control).toHaveAttribute('data-value', '');
		} else await expect(control).toContainText(choice.label);
	}
	await expect(menu).not.toBeVisible();
}
async function openRule(rule: Locator) {
	const details = rule.locator('.rule-details');
	if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}
function worldTile(page: Page, shape: string) {
	return page.getByRole('button', {
		name: shape[0].toUpperCase() + shape.slice(1) + ' world',
		exact: true,
		includeHidden: true
	});
}

async function editWorldNumber(page: Page, name: string, value: number) {
	const input = page.getByRole('spinbutton', { name: `${name} value`, exact: true });
	await input.fill(String(value));
	await input.press('Enter');
}

async function pause(page: Page) {
	await page.getByRole('button', { name: 'Pause simulation' }).click();
	await expect(page.locator('.status-strip')).toContainText('PAUSED');
	await expect(page.locator('.status-measures')).not.toContainText('—');
}

function interiorStagePixels(page: Page) {
	// Element screenshots include DOM overlays composited above the canvas.
	// Keep color comparisons inside the stage, clear of controls and FPS labels.
	return page.screenshot({ clip: { x: 24, y: 120, width: 1060, height: 720 } });
}

function chartScene(world: WorldDefinition): SceneDefinition {
	const scene = structuredClone(fixture) as unknown as SceneDefinition;
	scene.world = world;
	scene.speciesRules = [];
	scene.dynamics.timeScale = 0.01;
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.dynamics.metricSmoothingSeconds = 0;
	scene.camera.pitch = world.shape === 'plane' ? 0.7 : 0.3;
	for (const species of scene.species) {
		species.alignment = 0;
		species.cohesion = 0;
		species.separation = 0;
		species.cruiseSpeed = 0;
		species.rebels.fraction = 0;
		species.cursor.response = 'attract';
		species.cursor.strength = 1;
		species.cursor.vortex = 0;
	}
	scene.forces.radius = Math.min(6, worldInteractionLimit(world) * 0.8);
	if (world.shape === 'torus') {
		scene.camera.distance = 95;
		for (const species of scene.species)
			species.perception = Math.min(species.perception, worldInteractionLimit(world) * 0.7);
	}
	return scene;
}

function sampleProjection(scene: SceneDefinition, width: number, height: number) {
	const camera = new StageCamera(scene.camera);
	camera.update(width / height);
	const project = (position: Vec3) => {
		const [x, y] = camera.project(position);
		return { x: (x * 0.5 + 0.5) * width, y: (0.5 - y * 0.5) * height };
	};
	for (const agent of initializePopulation(scene).agents) {
		const normal = worldNormal(scene.world, agent.position);
		const visibility = normal.reduce(
			(sum, value, axis) => sum + value * (camera.position[axis] - agent.position[axis]),
			0
		);
		const point = project(agent.position);
		const [along] = localFrame(scene.world, agent.position);
		const offset = Math.min(2, scene.forces.radius * 0.6);
		const forcePosition = worldExp(scene.world, agent.position, [
			along[0] * offset,
			along[1] * offset,
			along[2] * offset
		]);
		const forcePoint = project(forcePosition);
		const hit = camera.hit(
			(point.x / width) * 2 - 1,
			1 - (point.y / height) * 2,
			scene.world,
			[0, 1, 0],
			0
		);
		const fieldHit = camera.hit(
			(forcePoint.x / width) * 2 - 1,
			1 - (forcePoint.y / height) * 2,
			scene.world,
			[0, 1, 0],
			0
		);
		const unobscured =
			hit &&
			fieldHit &&
			worldDistance(scene.world, agent.position, hit.position) < 0.02 &&
			worldDistance(scene.world, forcePosition, fieldHit.position) < 0.02;
		// Keep the sample and field away from the laboratory, inspector, and toolbars.
		if (
			visibility > 4 &&
			unobscured &&
			[point, forcePoint].every(({ x, y }) => x > 460 && x < 920 && y > 260 && y < 730)
		)
			return { agent, point, forcePoint };
	}
	throw new Error('Fixture has no unobscured front-facing agent.');
}

async function exportedScene(page: Page): Promise<SceneDefinition> {
	const event = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const file = await event;
	return JSON.parse(await readFile((await file.path())!, 'utf8')) as SceneDefinition;
}

test('both domains render, pause freezes physics, camera stays live, and capture contains the stage', async ({
	page
}, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	for (const surface of [false, true]) {
		await openWorld(page, surface);
		await pause(page);
		const clock = page.locator('.status-measures > span').first();
		await expect.poll(() => clock.innerText()).toMatch(/\d/);
		const frozen = await clock.innerText();
		const before = await page.locator('canvas').screenshot();
		await page.locator('canvas').focus();
		await page.keyboard.press('ArrowRight');
		await expect
			.poll(async () => Buffer.compare(before, await page.locator('canvas').screenshot()))
			.not.toBe(0);
		await expect(clock).toHaveText(frozen);
		await page.getByRole('button', { name: 'Advance one fixed simulation step' }).click();
		await expect.poll(() => clock.innerText()).not.toBe(frozen);
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Capture canvas as PNG' }).click();
		const capture = await download;
		const path = await capture.path();
		expect(path).toBeTruthy();
		expect((await stat(path!)).size).toBeGreaterThan(8000);
		const png = await readFile(path!);
		expect(png.subarray(1, 4).toString()).toBe('PNG');
		await page.screenshot({ path: testInfo.outputPath(surface ? 'sphere.png' : 'volume.png') });
	}
	expect(errors).toEqual([]);
});

test('scene storage, Unicode names, delete undo, load undo, export and corrupt import', async ({
	page
}) => {
	await openWorld(page);
	await pause(page);
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	await page.getByRole('textbox', { name: 'Scene name' }).fill('海の群れ ✦');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Load 海の群れ ✦' })).toBeVisible();
	await page.getByRole('button', { name: 'Delete 海の群れ ✦' }).click();
	await expect(page.getByRole('button', { name: 'Load 海の群れ ✦' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Load 海の群れ ✦' })).toBeVisible();
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const file = await download;
	const scene = JSON.parse(await readFile((await file.path())!, 'utf8'));
	expect(scene.name).toBe('海の群れ ✦');
	expect(scene.version).toBe(1);
	expect(scene.camera).toBeTruthy();
	await page.locator('input[type=file]').setInputFiles({
		name: 'corrupt.json',
		mimeType: 'application/json',
		buffer: Buffer.from('{oops')
	});
	await expect(page.getByText(/Unable to import:/)).toBeVisible();
	await page.getByRole('button', { name: /^Explore/ }).click();
	await page.getByRole('button', { name: /Small Planet/ }).click();
	await openSection(page, 'World');
	await expect(page.getByRole('button', { name: 'Surface', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await openSection(page, 'World');
	await expect(page.getByRole('button', { name: 'Volume', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('tool placement, erasing, species edits, and keyboard exclusions', async ({ page }) => {
	await openWorld(page);
	await pause(page);
	await page.getByRole('button', { name: 'Add species' }).click();
	await expect(page.getByRole('button', { name: /Remove Species 3/ })).toBeVisible();
	const name = page.getByRole('textbox', { name: 'Name', exact: true });
	await name.fill('Scout');
	await name.press('Space');
	await expect(name).toHaveValue('Scout ');
	await expect(page.getByRole('button', { name: 'Resume simulation' })).toBeEnabled();
	// Names commit on change/blur, while Space must remain text input.
	await name.press('Tab');
	await expect(page.getByRole('button', { name: /Remove Scout/ })).toBeVisible();
	await page.getByRole('button', { name: /Remove Scout/ }).click();
	await page.getByRole('button', { name: 'Obstacle', exact: true }).click();
	await expect(page.getByLabel('Obstacle brush')).toBeVisible();
	await page.locator('canvas').click({ position: { x: 900, y: 500 } });
	await expect(page.getByLabel('Obstacle brush')).toContainText('1/32');
	await page.getByRole('button', { name: 'Erase', exact: true }).click();
	await page.locator('canvas').click({ position: { x: 900, y: 500 } });
	await expect(page.getByLabel('Obstacle brush')).toContainText('0/32');
	await page.locator('canvas').focus();
	await page.keyboard.press('2');
	await expect(page.getByRole('button', { name: 'Force', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Look', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test.describe('paused presentation edits', () => {
	// DPR 2 makes Balanced/Sharp exercise different offscreen stage sizes.
	test.use({ deviceScaleFactor: 2 });
	test('cruise clamps to speed, render detail changes without physics, and export retains edits', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		// This fixture intentionally predates these fields. Loading must migrate
		// defaults before controls and export consume the complete scene.
		expect(fixture.visual).not.toHaveProperty('quality');
		for (const species of fixture.species) expect(species).not.toHaveProperty('cruiseSpeed');
		await openWorld(page);
		await pause(page);
		await expect(page.locator('.status-measures [data-time-scale] b')).toHaveText('0.00');
		const clock = page.locator('.status-measures [data-tick]');
		const frozenClock = await clock.innerText();
		const frozenTick = await clock.getAttribute('data-tick');
		await openSection(page, 'Flocking');
		const cruise = page.getByRole('slider', { name: 'Cruise target', exact: true });
		const speed = page.getByRole('slider', { name: 'Speed limit', exact: true });
		await expect(cruise).toHaveValue(String(fixture.species[0].speed * 0.3));
		await cruise.focus();
		await page.keyboard.press('End');
		await expect(cruise).toHaveValue(String(fixture.species[0].speed));
		await speed.focus();
		await page.keyboard.press('Home');
		await expect(speed).toHaveValue('0.1');
		await expect(cruise).toHaveValue('0.1');
		await expect(cruise).toHaveAttribute('max', '0.1');
		await openSection(page, 'Appearance');
		const detail = page.getByRole('combobox', { name: 'Render detail', exact: true });
		await expect(detail).toHaveAttribute('data-value', 'balanced');
		const canvas = page.locator('canvas');
		const balancedPixels = await canvas.screenshot();
		await selectChoice(page, detail, 'sharp');
		await expect
			.poll(async () => Buffer.compare(balancedPixels, await canvas.screenshot()))
			.not.toBe(0);
		const sharpPixels = await canvas.screenshot();
		await selectChoice(page, detail, 'fast');
		await expect(detail).toHaveAttribute('data-value', 'fast');
		await expect
			.poll(async () => Buffer.compare(sharpPixels, await canvas.screenshot()))
			.not.toBe(0);
		await selectChoice(page, detail, 'balanced');
		await expect(detail).toHaveAttribute('data-value', 'balanced');
		await expect
			.poll(async () => Buffer.compare(sharpPixels, await canvas.screenshot()))
			.not.toBe(0);
		const restoredBalancedPixels = await canvas.screenshot();
		await selectChoice(page, detail, 'sharp');
		await expect(detail).toHaveAttribute('data-value', 'sharp');
		await expect
			.poll(async () => Buffer.compare(restoredBalancedPixels, await canvas.screenshot()))
			.not.toBe(0);
		await expect(clock).toHaveText(frozenClock);
		await expect(clock).toHaveAttribute('data-tick', frozenTick!);
		const beforeOrbit = await canvas.screenshot();
		await canvas.focus();
		await page.keyboard.press('ArrowRight');
		await expect
			.poll(async () => Buffer.compare(beforeOrbit, await canvas.screenshot()))
			.not.toBe(0);
		const captureEvent = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Capture canvas as PNG' }).click();
		const capture = await captureEvent;
		const png = await readFile((await capture.path())!);
		expect(png.subarray(1, 4).toString()).toBe('PNG');
		const canvasSize = await canvas.evaluate((element: HTMLCanvasElement) => ({
			width: element.width,
			height: element.height
		}));
		expect(png.readUInt32BE(16)).toBe(canvasSize.width);
		expect(png.readUInt32BE(20)).toBe(canvasSize.height);
		await page.getByRole('button', { name: 'Scenes', exact: true }).click();
		const exportEvent = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Export', exact: true }).click();
		const exportedFile = await exportEvent;
		const exported = JSON.parse(
			await readFile((await exportedFile.path())!, 'utf8')
		) as SceneDefinition;
		expect(exported.visual.quality).toBe('sharp');
		expect(exported.species[0].speed).toBe(0.1);
		expect(exported.species[0].cruiseSpeed).toBe(0.1);
		expect(exported.species[1].cruiseSpeed).toBeCloseTo(fixture.species[1].speed * 0.3);
		expect(exported.species.map(({ key, population }) => ({ key, population }))).toEqual(
			fixture.species.map(({ key, population }) => ({ key, population }))
		);
		expect(exported.camera.yaw).toBeCloseTo(fixture.camera.yaw + 0.08);
		await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
		await expect(clock).toHaveText(frozenClock);
		await expect(clock).toHaveAttribute('data-tick', frozenTick!);
		await expect(page.getByRole('button', { name: 'Resume simulation' })).toBeEnabled();
		expect(errors).toEqual([]);
	});
});

test('unsupported WebGPU has readable recovery and usable scene tools', async ({ page }) => {
	await page.addInitScript(() =>
		Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })
	);
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'The GPU world is unavailable' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
});

for (const world of [
	{ kind: 'surface', shape: 'plane', halfExtents: [18, 14], boundaries: 'reflect' },
	{ kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 14 },
	{ kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 }
] satisfies WorldDefinition[]) {
	test(`${world.shape} surface: physical picking, force, dimensions, obstacles and scene round-trip`, async ({
		page
	}, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		const scene = chartScene(world);
		await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
		await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
			timeout: 45000
		});
		await pause(page);
		await openSection(page, 'World');
		await expect(worldTile(page, world.shape)).toHaveAttribute('aria-pressed', 'true');
		const canvas = page.locator('canvas');
		const bounds = await canvas.boundingBox();
		expect(bounds).toBeTruthy();
		const { agent, point, forcePoint } = sampleProjection(scene, bounds!.width, bounds!.height);
		await page.getByRole('button', { name: 'Inspect', exact: true }).click();
		await canvas.click({ position: point });
		const inspector = page.getByLabel('Selected agent inspector');
		await expect(inspector.locator('h2')).toContainText(`#${agent.id}`);
		await expect(inspector).toContainText('Surface UV');
		if (world.shape === 'torus') await expect(inspector).toContainText('Tube θ · ring φ');
		const clock = page.locator('.status-measures [data-tick]');
		const frozenTick = await clock.getAttribute('data-tick');
		await page.getByRole('button', { name: 'Force', exact: true }).click();
		await page.mouse.move(bounds!.x + forcePoint.x, bounds!.y + forcePoint.y);
		await page.mouse.down();
		try {
			await page.keyboard.press('.');
			await expect(clock).not.toHaveAttribute('data-tick', frozenTick!);
			await expect
				.poll(async () =>
					Number.parseFloat(await inspector.locator('.inspect-metrics dd').nth(2).innerText())
				)
				.toBeGreaterThan(0.05);
		} finally {
			await page.mouse.up();
		}
		await page.getByRole('button', { name: 'Close agent inspector' }).click();
		await openSection(page, 'World');
		await expect(worldTile(page, world.shape)).toHaveAttribute('aria-pressed', 'true');
		const editedWorld: WorldDefinition = structuredClone(world);
		if (editedWorld.shape === 'plane') {
			await selectChoice(
				page,
				page.getByRole('combobox', { name: 'Boundary', exact: true }),
				'periodic'
			);
			editedWorld.boundaries = 'periodic';
			for (const [label, index] of [
				['Width', 0],
				['Depth', 1]
			] as const) {
				const dimension = page.getByRole('slider', { name: label, exact: true });
				await dimension.focus();
				await page.keyboard.press('ArrowRight');
				editedWorld.halfExtents = [
					editedWorld.halfExtents[0] + (index === 0 ? 0.5 : 0),
					editedWorld.halfExtents[1] + (index === 1 ? 0.5 : 0)
				];
				await expect(dimension).toHaveValue(String(editedWorld.halfExtents[index] * 2));
			}
		} else if (editedWorld.shape === 'torus') {
			const major = page.getByRole('slider', { name: 'Major radius', exact: true });
			const tube = page.getByRole('slider', { name: 'Tube radius', exact: true });
			await expect(major).toHaveAttribute('min', '16');
			await expect(major).toHaveAttribute('max', '80');
			await major.focus();
			await page.keyboard.press('ArrowRight');
			editedWorld.majorRadius = 20.5;
			await expect(major).toHaveValue('20.5');
			await expect(tube).toHaveAttribute('min', '2.05');
			await expect(tube).toHaveAttribute('max', '10.25');
			await tube.focus();
			await page.keyboard.press('ArrowRight');
			editedWorld.tubeRadius = Number(await tube.inputValue());
			expect(editedWorld.tubeRadius).toBeGreaterThan(
				world.shape === 'torus' ? world.tubeRadius : 8
			);
			await expect(page.getByRole('combobox', { name: 'Boundary', exact: true })).toHaveCount(0);
			await expect(page.getByLabel('Selected agent inspector')).toHaveCount(0);
		} else {
			await page.getByRole('slider', { name: 'Cylinder radius', exact: true }).focus();
			await page.keyboard.press('ArrowRight');
			editedWorld.radius += 0.5;
			await page.getByRole('slider', { name: 'Cylinder height', exact: true }).focus();
			await page.keyboard.press('ArrowRight');
			editedWorld.halfHeight += 0.5;
			await expect(page.getByRole('slider', { name: 'Cylinder radius', exact: true })).toHaveValue(
				'12.5'
			);
			await expect(page.getByRole('slider', { name: 'Cylinder height', exact: true })).toHaveValue(
				'29'
			);
			await expect(page.getByRole('combobox', { name: 'Boundary', exact: true })).toHaveCount(0);
		}
		await expect(page.getByRole('button', { name: 'Resume simulation' })).toBeEnabled();
		await openSection(page, 'Forces');
		await expect(page.getByRole('slider', { name: 'Placement depth' })).toHaveCount(0);
		await expect(page.getByRole('combobox', { name: 'Work plane' })).toHaveCount(0);
		let center = { x: bounds!.width / 2, y: bounds!.height / 2 };
		if (editedWorld.shape === 'torus') {
			// The central opening is empty. Use the production fitted camera to choose the actual tube.
			await page.getByRole('button', { name: 'Scenes', exact: true }).click();
			const framed = await exportedScene(page);
			await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
			center = sampleProjection(framed, bounds!.width, bounds!.height).point;
		}
		await page.getByRole('button', { name: 'Obstacle', exact: true }).click();
		await page.getByRole('combobox', { name: 'Primitive' }).click();
		await expect(
			page
				.getByRole('listbox', { name: 'Primitive' })
				.getByRole('option', { name: 'Box', exact: true })
		).toHaveCount(0);
		await page.keyboard.press('Escape');
		if (editedWorld.shape === 'torus') {
			await page.getByRole('slider', { name: 'Disk radius', exact: true }).focus();
			await page.keyboard.press('Home');
		}
		await canvas.click({ position: center });
		await expect(page.getByLabel('Obstacle brush')).toContainText('1/32');
		await selectChoice(page, page.getByRole('combobox', { name: 'Primitive' }), 'ring');
		await canvas.click({ position: center });
		await expect(page.getByLabel('Obstacle brush')).toContainText('17/32');
		await page.getByRole('button', { name: 'Erase', exact: true }).click();
		await canvas.click({ position: center });
		await expect(page.getByLabel('Obstacle brush')).toContainText('16/32');
		await page.getByRole('button', { name: 'Look', exact: true }).click();
		if (editedWorld.shape === 'torus') {
			const pausedClock = await clock.innerText();
			const beforeOrbit = await canvas.screenshot();
			await canvas.focus();
			await page.keyboard.press('ArrowRight');
			await expect
				.poll(async () => Buffer.compare(beforeOrbit, await canvas.screenshot()))
				.not.toBe(0);
			await expect(clock).toHaveText(pausedClock);
			await openSection(page, 'World');
		}
		const captureEvent = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Capture canvas as PNG' }).click();
		const capture = await captureEvent;
		expect((await readFile((await capture.path())!)).subarray(1, 4).toString()).toBe('PNG');
		await page.screenshot({ path: testInfo.outputPath(`${world.shape}.png`) });
		await page.getByRole('button', { name: 'Scenes', exact: true }).click();
		const name = `${world.shape} · 曲面`;
		await page.getByRole('textbox', { name: 'Scene name' }).fill(name);
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByRole('button', { name: `Load ${name}` })).toBeVisible();
		const exported = await exportedScene(page);
		expect(exported.world).toEqual(editedWorld);
		const bound =
			editedWorld.shape === 'plane'
				? Math.hypot(...editedWorld.halfExtents)
				: editedWorld.shape === 'torus'
					? editedWorld.majorRadius + editedWorld.tubeRadius
					: Math.hypot(editedWorld.radius, editedWorld.halfHeight);
		const vertical = (21 * Math.PI) / 180;
		const angle = Math.min(
			vertical,
			Math.atan((Math.tan(vertical) * bounds!.width) / bounds!.height)
		);
		expect(exported.camera.distance).toBeCloseTo(
			((bound + Math.max(...exported.species.map((species) => species.size)) * 2) /
				Math.sin(angle)) *
				1.05,
			5
		);
		expect(exported.camera.target).toEqual([0, 0, 0]);
		expect(exported.obstacles).toHaveLength(16);
		for (const obstacle of exported.obstacles) {
			expect(obstacle.shape).toBe('sphere');
			if (editedWorld.shape === 'plane') expect(Math.abs(obstacle.center[1])).toBeLessThan(1e-6);
			else if (editedWorld.shape === 'torus') {
				expect(
					Math.hypot(
						Math.hypot(obstacle.center[0], obstacle.center[2]) - editedWorld.majorRadius,
						obstacle.center[1]
					)
				).toBeCloseTo(editedWorld.tubeRadius, 5);
			} else
				expect(Math.hypot(obstacle.center[0], obstacle.center[2])).toBeCloseTo(
					editedWorld.radius,
					5
				);
		}
		await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
		await openSection(page, 'World');
		await page.getByRole('button', { name: 'Volume', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Volume', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await page.getByRole('button', { name: 'Scenes', exact: true }).click();
		await page.getByRole('button', { name: /^Saved/ }).click();
		await page.getByRole('button', { name: `Load ${name}` }).click();
		await openSection(page, 'World');
		await expect(worldTile(page, world.shape)).toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: 'Scenes', exact: true }).click();
		const restored = await exportedScene(page);
		expect(restored.world).toEqual(exported.world);
		expect(restored.obstacles).toEqual(exported.obstacles);
		expect(restored.camera).toEqual(exported.camera);
		if (editedWorld.shape === 'torus') {
			for (const invalid of ['range', 'shape'] as const) {
				const unsupported = structuredClone(exported);
				if (invalid === 'range')
					unsupported.species[0].perception = worldInteractionLimit(unsupported.world);
				else if (unsupported.world.shape === 'torus')
					unsupported.world.tubeRadius = unsupported.world.majorRadius;
				await page.locator('input[type=file]').setInputFiles({
					name: `unsupported-${invalid}.json`,
					mimeType: 'application/json',
					buffer: Buffer.from(JSON.stringify(unsupported))
				});
				await expect(page.getByText(/Unable to import:/)).toBeVisible();
				await expect(worldTile(page, 'torus')).toHaveAttribute('aria-pressed', 'true');
			}
		}
		await page.locator('input[type=file]').setInputFiles({
			name: `${world.shape}.json`,
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(exported))
		});
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Resume simulation' })).toBeEnabled();
		await openSection(page, 'World');
		await worldTile(page, 'sphere').click();
		await expect(worldTile(page, 'sphere')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByRole('slider', { name: 'Sphere radius' })).toHaveValue('14');
		await worldTile(page, world.shape).click();
		await openSection(page, 'World');
		await expect(worldTile(page, world.shape)).toHaveAttribute('aria-pressed', 'true');
		await expect(clock).toHaveAttribute('data-tick', '0');
		await expect(page.locator('.obstacle-row')).toHaveCount(0);
		if (world.shape === 'torus') {
			await page.getByRole('slider', { name: 'Tube radius', exact: true }).focus();
			await page.keyboard.press('Home');
			await expect(page.getByRole('slider', { name: 'Tube radius', exact: true })).toHaveValue('2');
			await expect(page.getByText(/Ranges adjusted for this surface:/)).toBeVisible();
			await page.getByRole('button', { name: 'Scenes', exact: true }).click();
			const adjusted = await exportedScene(page);
			expect(
				adjusted.species.every(
					(species) => species.perception < worldInteractionLimit(adjusted.world)
				)
			).toBe(true);
			expect(adjusted.forces.radius).toBeLessThan(worldInteractionLimit(adjusted.world));
			expect(adjusted.species.every((species) => species.size < 0.15)).toBe(true);
		}
		expect(errors).toEqual([]);
	});
}

test('recording falls back to a real supported encoder, Escape stops it, and the download decodes', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	// Exercise a browser without MP4 support; the selected fallback still uses
	// the browser's actual MediaRecorder encoder and real canvas stream.
	await page.addInitScript(() => {
		const native = MediaRecorder.isTypeSupported.bind(MediaRecorder);
		MediaRecorder.isTypeSupported = (mime) => !mime.startsWith('video/mp4') && native(mime);
	});
	await openWorld(page);
	await pause(page);
	expect(await page.evaluate(() => MediaRecorder.isTypeSupported('video/webm'))).toBe(true);
	const clock = page.locator('.status-measures [data-tick]');
	const frozen = await clock.innerText();
	await page.getByRole('button', { name: 'Record canvas video' }).click();
	const recording = page.locator('.recording-indicator');
	await expect(recording).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Stop video recording', exact: true })
	).toBeEnabled();
	await page.locator('canvas').focus();
	await page.keyboard.press('ArrowRight');
	const firstFrame = await page.locator('canvas').screenshot();
	await expect(recording).toContainText('00:01', { timeout: 10000 });
	await page.keyboard.press('ArrowRight');
	await expect
		.poll(async () => Buffer.compare(firstFrame, await page.locator('canvas').screenshot()))
		.not.toBe(0);
	// Escape must work even while a form control has focus.
	await openSection(page, 'Species');
	await page.getByRole('textbox', { name: 'Name', exact: true }).focus();
	const downloadEvent = page.waitForEvent('download');
	await page.keyboard.press('Escape');
	const capture = await downloadEvent;
	await expect(recording).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Record canvas video' })).toBeEnabled();
	await expect(clock).toHaveText(frozen);
	expect(capture.suggestedFilename()).toMatch(/\.webm$/);
	const video = await readFile((await capture.path())!);
	expect(video.length).toBeGreaterThan(1000);
	expect(video.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
	const decoded = await page.evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (letter) => letter.charCodeAt(0));
		const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
		const element = document.createElement('video');
		element.muted = true;
		element.src = url;
		try {
			await new Promise<void>((resolve, reject) => {
				element.onloadeddata = () => resolve();
				element.onerror = () => reject(new Error('Downloaded video could not decode.'));
				element.load();
			});
			return { width: element.videoWidth, height: element.videoHeight, ready: element.readyState };
		} finally {
			element.removeAttribute('src');
			element.load();
			URL.revokeObjectURL(url);
		}
	}, video.toString('base64'));
	const canvas = await page.locator('canvas').evaluate((element: HTMLCanvasElement) => ({
		width: element.width,
		height: element.height
	}));
	expect(decoded.width).toBe(canvas.width);
	expect(decoded.height).toBe(canvas.height);
	expect(decoded.ready).toBeGreaterThanOrEqual(2);
	expect(errors).toEqual([]);
});

test('keyboard curve edits preserve endpoints and independent channel mappings without moving the camera', async ({
	page
}) => {
	await openWorld(page);
	await pause(page);
	const clock = page.locator('.status-measures [data-tick]');
	const frozen = await clock.innerText();
	await openSection(page, 'Appearance');
	const hue = page.locator('[data-channel="hue"]');
	await expect(hue.getByRole('button', { name: 'Hue curve', exact: true })).toHaveCount(0);
	await expect(hue.getByRole('checkbox', { name: 'Enable hue mapping' })).not.toBeChecked();
	await selectChoice(page, hue.getByRole('combobox', { name: 'Hue source' }), 'anisotropy');
	await expect(hue.getByRole('checkbox', { name: 'Enable hue mapping' })).toBeChecked();
	await hue.getByRole('checkbox', { name: 'Enable hue mapping' }).uncheck();
	await expect(hue.getByRole('slider', { name: 'Strength', exact: true })).toBeDisabled();
	await hue.getByRole('button', { name: 'Hue curve', exact: true }).click();
	await expect(hue.getByRole('checkbox', { name: 'Enable hue mapping' })).not.toBeChecked();
	await expect(hue).toContainText('edits apply when enabled');
	await selectChoice(page, hue.getByRole('combobox', { name: 'Curve preset' }), {
		label: 'Linear'
	});
	await hue.getByRole('button', { name: 'Add curve point', exact: true }).click();
	const points = hue.locator('.curve-point');
	await expect(points).toHaveCount(3);
	const middle = hue.getByRole('button', { name: /^Point 2,/ });
	await middle.focus();
	await page.keyboard.press('Shift+ArrowUp');
	await page.keyboard.press('ArrowRight');
	await expect(middle).toHaveAttribute('aria-label', /input 0\.51, output 0\.60/);
	await hue.getByRole('button', { name: /^Point 1,/ }).focus();
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('Delete');
	await expect(points).toHaveCount(3);
	await expect(hue.getByRole('button', { name: /^Point 1,/ })).toHaveAttribute(
		'aria-label',
		/input 0\.00/
	);
	await middle.focus();
	await page.keyboard.press('Delete');
	await expect(points).toHaveCount(2);
	await hue.getByRole('button', { name: 'Add curve point', exact: true }).click();
	await middle.focus();
	await page.keyboard.press('Shift+ArrowUp');
	await page.keyboard.press('ArrowRight');
	await hue.getByRole('checkbox', { name: 'Enable hue mapping' }).check();
	// Closing an editor does not disable its mapping.
	await hue.getByRole('button', { name: 'Hue curve', exact: true }).click();
	await expect(hue.getByRole('checkbox', { name: 'Enable hue mapping' })).toBeChecked();
	const saturation = page.locator('[data-channel="saturation"]');
	await selectChoice(
		page,
		saturation.getByRole('combobox', { name: 'Saturation source' }),
		'flow-orbit'
	);
	await saturation.getByRole('checkbox', { name: 'Enable saturation mapping' }).check();
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const saved = await exportedScene(page);
	expect(saved.species[0].visual.hue.enabled).toBe(true);
	expect(saved.species[0].visual.hue.source).toBe('anisotropy');
	const curve = saved.species[0].visual.hue.curve.points;
	expect(curve).toHaveLength(3);
	expect(curve[0]).toEqual([0, 0]);
	expect(curve[1][0]).toBeCloseTo(0.51);
	expect(curve[1][1]).toBeCloseTo(0.6);
	expect(curve[2]).toEqual([1, 1]);
	expect(saved.species[0].visual.saturation.enabled).toBe(true);
	expect(saved.species[0].visual.saturation.source).toBe('flow-orbit');
	expect(saved.species[0].visual.saturation.curve.points).toEqual([
		[0, 0],
		[1, 1]
	]);
	expect(saved.camera).toEqual(fixture.camera);
	await expect(clock).toHaveText(frozen);
});

test('species hue edits change rendered pixels while paused and metric mode controls activate explicitly', async ({
	page
}, testInfo) => {
	await openWorld(page);
	await pause(page);
	await openSection(page, 'Appearance');
	const clock = page.locator('.status-measures [data-tick]');
	const frozen = await clock.innerText();
	const hue = page.locator('[data-channel="hue"]');
	const slider = hue.getByRole('slider', { name: 'Hue', exact: true });
	await expect(slider).toBeVisible();
	await expect(hue.getByRole('slider', { name: 'Strength', exact: true })).toHaveCount(0);
	await expect(hue.getByRole('button', { name: 'Hue curve', exact: true })).toHaveCount(0);
	await expect(hue.getByRole('checkbox', { name: 'Enable hue mapping' })).toBeDisabled();
	await slider.focus();
	await page.keyboard.press('Home');
	await expect(slider).toHaveValue('0');
	// Establish a stable paused frame before checking the color change.
	let red = await interiorStagePixels(page);
	await expect
		.poll(async () => {
			const next = await interiorStagePixels(page);
			const equal = Buffer.compare(red, next) === 0;
			red = next;
			return equal;
		})
		.toBe(true);
	await slider.focus();
	await page.keyboard.press('End');
	for (let i = 0; i < 4; i++) await page.keyboard.press('PageDown');
	await expect(slider).toHaveValue('216');
	await expect.poll(async () => Buffer.compare(red, await interiorStagePixels(page))).not.toBe(0);
	await page.screenshot({ path: testInfo.outputPath('species-hue-blue.png') });
	await slider.focus();
	await page.keyboard.press('Home');
	await expect.poll(async () => Buffer.compare(red, await interiorStagePixels(page))).toBe(0);
	await expect(clock).toHaveText(frozen);
	await selectChoice(page, hue.getByRole('combobox', { name: 'Hue source' }), 'heading-azimuth');
	await expect(hue.getByRole('checkbox', { name: 'Enable hue mapping' })).toBeChecked();
	await expect.poll(async () => Buffer.compare(red, await interiorStagePixels(page))).not.toBe(0);
	const strength = hue.getByRole('slider', { name: 'Strength', exact: true });
	await expect(strength).toBeEnabled();
	await expect(hue.getByRole('slider', { name: 'Base hue', exact: true })).toBeVisible();
	await strength.focus();
	await page.keyboard.press('End');
	await expect(hue.getByRole('slider', { name: 'Base hue', exact: true })).toHaveCount(0);
	await expect(hue).toContainText('Metric replaces species hue');
	await expect.poll(async () => Buffer.compare(red, await interiorStagePixels(page))).not.toBe(0);
	let mapped = await interiorStagePixels(page);
	await expect
		.poll(async () => {
			const next = await interiorStagePixels(page);
			const equal = Buffer.compare(mapped, next) === 0;
			mapped = next;
			return equal;
		})
		.toBe(true);
	await hue.getByRole('checkbox', { name: 'Enable hue mapping' }).uncheck();
	await expect(strength).toBeDisabled();
	await expect(hue.getByRole('slider', { name: 'Base hue', exact: true })).toBeVisible();
	await expect.poll(async () => Buffer.compare(red, await interiorStagePixels(page))).toBe(0);
	await hue.getByRole('button', { name: 'Hue curve', exact: true }).click();
	await expect(hue.getByRole('checkbox', { name: 'Enable hue mapping' })).not.toBeChecked();
	await hue.getByRole('checkbox', { name: 'Enable hue mapping' }).check();
	await expect.poll(async () => Buffer.compare(mapped, await interiorStagePixels(page))).toBe(0);
	await selectChoice(page, hue.getByRole('combobox', { name: 'Curve preset' }), {
		label: 'Linear'
	});
	await expect.poll(async () => Buffer.compare(mapped, await interiorStagePixels(page))).toBe(0);
	await selectChoice(page, hue.getByRole('combobox', { name: 'Curve preset' }), {
		label: 'Inverted'
	});
	await expect
		.poll(async () => Buffer.compare(mapped, await interiorStagePixels(page)))
		.not.toBe(0);
	await page.screenshot({ path: testInfo.outputPath('metric-hue-inverted.png') });
	await expect(clock).toHaveText(frozen);
	await selectChoice(page, hue.getByRole('combobox', { name: 'Hue source' }), 'constant');
	await expect(hue.getByRole('checkbox', { name: 'Enable hue mapping' })).not.toBeChecked();
	await expect(hue.getByRole('button', { name: 'Hue curve', exact: true })).toHaveCount(0);
	await expect(slider).toBeVisible();
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const saved = await exportedScene(page);
	expect(saved.species[0].visual.hsl[0]).toBe(0);
	expect(saved.species[0].visual.hue).toMatchObject({ source: 'constant', enabled: false });
	expect(saved.species[0].visual.saturation).toEqual(fixture.species[0].visual.saturation);
	expect(saved.species[0].visual.lightness).toEqual(fixture.species[0].visual.lightness);
});

test('continuous hue input repaints a paused stage and allows running physics to advance', async ({
	page
}, testInfo) => {
	await openWorld(page);
	await pause(page);
	await openSection(page, 'Appearance');
	const clock = page.locator('.status-measures [data-tick]');
	const frozen = await clock.innerText();
	const slider = page.locator('[data-channel="hue"]').getByRole('slider', {
		name: 'Hue',
		exact: true
	});
	await slider.focus();
	await page.keyboard.press('Home');
	let baseline = await interiorStagePixels(page);
	await expect
		.poll(async () => {
			const next = await interiorStagePixels(page);
			const equal = Buffer.compare(baseline, next) === 0;
			baseline = next;
			return equal;
		})
		.toBe(true);
	await slider.evaluate((input: HTMLInputElement) => {
		input.dataset.appearanceInputsActive = 'true';
		input.dataset.appearanceInputFrames = '0';
		function edit() {
			if (input.dataset.appearanceInputsActive !== 'true') return;
			const frame = Number(input.dataset.appearanceInputFrames) + 1;
			// Both hues differ from the red baseline; a continuous drag must repaint
			// before it ends, regardless of which input the latest frame consumes.
			input.value = String(frame % 2 ? 180 : 240);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dataset.appearanceInputFrames = String(frame);
			requestAnimationFrame(edit);
		}
		requestAnimationFrame(edit);
	});
	const frameCount = async () => Number(await slider.getAttribute('data-appearance-input-frames'));
	try {
		await expect.poll(frameCount).toBeGreaterThanOrEqual(20);
		await expect
			.poll(async () => Buffer.compare(baseline, await interiorStagePixels(page)))
			.not.toBe(0);
		await expect(slider).toHaveAttribute('data-appearance-inputs-active', 'true');
		await expect(clock).toHaveText(frozen);
		await page.screenshot({ path: testInfo.outputPath('continuous-hue-paused.png') });
		await page.getByRole('button', { name: 'Resume simulation' }).click();
		const runningStart = await clock.innerText();
		const runningFrame = await frameCount();
		await expect.poll(frameCount).toBeGreaterThanOrEqual(runningFrame + 30);
		await expect.poll(() => clock.innerText()).not.toBe(runningStart);
		await expect(slider).toHaveAttribute('data-appearance-inputs-active', 'true');
	} finally {
		await slider.evaluate((input: HTMLInputElement) => {
			input.dataset.appearanceInputsActive = 'false';
		});
	}
});

test.describe('touchscreen interaction', () => {
	test.use({ hasTouch: true, viewport: { width: 393, height: 852 } });
	test('tool taps paint and erase while a two-finger gesture only navigates', async ({ page }) => {
		const scene = chartScene({
			kind: 'surface',
			shape: 'plane',
			halfExtents: [18, 18],
			boundaries: 'reflect'
		});
		await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
		await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
			timeout: 45000
		});
		await page.getByRole('button', { name: 'Pause simulation' }).tap();
		await expect(page.locator('.status-strip')).toContainText('PAUSED');
		await page.getByRole('button', { name: 'Hide laboratory (L)' }).tap();
		await page.getByRole('button', { name: 'Obstacle', exact: true }).tap();
		const brush = page.getByLabel('Obstacle brush');
		const point = { x: 200, y: 470 };
		await page.touchscreen.tap(point.x, point.y);
		await expect(brush).toContainText('1/32');
		await page.getByRole('button', { name: 'Erase', exact: true }).tap();
		await page.touchscreen.tap(point.x, point.y);
		await expect(brush).toContainText('0/32');
		await page.getByRole('button', { name: 'Place', exact: true }).tap();
		const clock = page.locator('.status-measures [data-tick]');
		await expect(clock.locator('b')).toHaveText(/^\d+\.\d{3}$/);
		const frozen = await clock.innerText();
		const before = await page.locator('canvas').screenshot();
		// CDP delivers real browser touch input with two simultaneous contacts.
		const session = await page.context().newCDPSession(page);
		await session.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [
				{ x: 145, y: 465, id: 1 },
				{ x: 245, y: 465, id: 2 }
			]
		});
		await session.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [
				{ x: 110, y: 490, id: 1 },
				{ x: 280, y: 490, id: 2 }
			]
		});
		await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await session.detach();
		await expect(brush).toContainText('0/32');
		await expect
			.poll(async () => Buffer.compare(before, await page.locator('canvas').screenshot()))
			.not.toBe(0);
		await expect(clock).toHaveText(frozen);
		await page.getByRole('button', { name: 'Look', exact: true }).tap();
		await expect(page.getByRole('button', { name: 'Look', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await page.getByRole('button', { name: 'Show laboratory (L)' }).tap();
		await page.getByRole('button', { name: 'Scenes', exact: true }).tap();
		const navigated = await exportedScene(page);
		expect(navigated.obstacles).toHaveLength(0);
		expect(navigated.camera.distance).toBeLessThan(scene.camera.distance);
		expect(navigated.camera.target).toEqual(scene.camera.target);
		expect(navigated.camera.pan).not.toEqual([0, 0]);
		expect(navigated.camera.pan).toBeDefined();
	});
});

test('new species flee all others by default and explicit rules stay independently editable', async ({
	page
}) => {
	await openWorld(page);
	await pause(page);
	await page.getByRole('button', { name: 'Add species', exact: true }).click();
	await openSection(page, 'Interactions');
	const rules = page.locator('[data-rule-family="species"]');
	await expect(rules).toHaveCount(1);
	const fallback = rules.first();
	await expect(fallback.locator('.rule-source')).toContainText('Species 3');
	await expect(fallback.getByRole('combobox', { name: 'Target species' })).toHaveAttribute(
		'data-value',
		'*'
	);
	await expect(fallback.getByRole('combobox', { name: 'Behavior', exact: true })).toHaveAttribute(
		'data-value',
		'flee'
	);
	await openRule(fallback);
	await expect(fallback.getByRole('slider', { name: 'Strength', exact: true })).toHaveValue('1');
	await expect(fallback.getByRole('checkbox', { name: 'Use perception radius' })).toBeChecked();
	await page.getByRole('button', { name: 'Add species rule', exact: true }).click();
	await expect(rules).toHaveCount(2);
	const explicit = rules.nth(1);
	await expect(explicit.getByRole('combobox', { name: 'Target species' })).toHaveAttribute(
		'data-value',
		'shoal'
	);
	await selectChoice(
		page,
		explicit.getByRole('combobox', { name: 'Behavior', exact: true }),
		'ignore'
	);
	await expect(explicit.locator('.rule-state')).toContainText('Ignore override');
	await expect(fallback.getByRole('combobox', { name: 'Behavior', exact: true })).toHaveAttribute(
		'data-value',
		'flee'
	);
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const saved = await exportedScene(page);
	const added = saved.species.find((species) => species.name === 'Species 3')!;
	expect(saved.speciesRules).toEqual([
		expect.objectContaining({
			from: added.key,
			to: '*',
			behavior: 'flee',
			strength: 1,
			radius: null
		}),
		expect.objectContaining({ from: added.key, to: 'shoal', behavior: 'ignore' })
	]);
	// Loading a custom scene and adding a species preserves its existing species' deliberate rules.
	expect(saved.speciesRules.some((rule) => rule.from === 'shoal' || rule.from === 'amber')).toBe(
		false
	);
});

test('compact controls expose independent color channels, directed rules, and requested simulation speed', async ({
	page
}, testInfo) => {
	await openWorld(page);
	await pause(page);
	const panel = page.getByLabel('Swarm laboratory');
	const bounds = await panel.boundingBox();
	expect(bounds!.width).toBeLessThanOrEqual(288);
	expect(bounds!.x).toBeGreaterThan(1000);
	for (const name of [
		'Species',
		'Flocking',
		'Interactions',
		'World',
		'Forces',
		'Appearance',
		'Dynamics'
	]) {
		await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
	}
	const clock = page.locator('.status-measures [data-tick]');
	const frozen = await clock.innerText();
	const requested = page.getByRole('slider', { name: 'Simulation speed', exact: true });
	await requested.focus();
	await page.keyboard.press('End');
	await expect(requested).toHaveValue('3');
	await expect(page.locator('.playback-speed output')).toHaveText('3.00×');
	await expect(page.locator('.status-measures [data-time-scale]')).toContainText('0.00× achieved');
	await openSection(page, 'Interactions');
	await page.getByRole('button', { name: 'Add species rule', exact: true }).click();
	const relation = page.locator('[data-rule-family="species"]').first();
	await expect(relation.locator('.rule-source')).toContainText('Jade');
	await selectChoice(page, relation.getByRole('combobox', { name: 'Target species' }), 'amber');
	await selectChoice(
		page,
		relation.getByRole('combobox', { name: 'Behavior', exact: true }),
		'chase'
	);
	await expect(relation.locator('.rule-state')).toContainText('1.0× · perception');
	await openRule(relation);
	await relation.getByRole('slider', { name: 'Strength', exact: true }).focus();
	await page.keyboard.press('End');
	await expect(relation.getByRole('slider', { name: 'Radius', exact: true })).toBeDisabled();
	await relation.getByRole('checkbox', { name: 'Use perception radius' }).uncheck();
	await relation.getByRole('slider', { name: 'Radius', exact: true }).focus();
	await page.keyboard.press('End');
	await page.getByRole('button', { name: 'Add species rule', exact: true }).click();
	const fallback = page.locator('[data-rule-family="species"]').nth(1);
	await selectChoice(
		page,
		fallback.getByRole('combobox', { name: 'Behavior', exact: true }),
		'ignore'
	);
	await expect(fallback.locator('.rule-state')).toContainText('Ignore override');
	await openRule(fallback);
	await expect(fallback.getByRole('slider', { name: 'Strength', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Add metric rule', exact: true }).click();
	const metric = page.locator('[data-rule-family="metric"]');
	await openRule(metric);
	await selectChoice(
		page,
		metric.getByRole('combobox', { name: 'Metric source' }),
		'speed-contrast'
	);
	await selectChoice(page, metric.getByRole('combobox', { name: 'Read from' }), 'difference');
	await selectChoice(
		page,
		metric.getByRole('combobox', { name: 'Behavior', exact: true }),
		'mirror'
	);
	await metric.getByRole('button', { name: 'Metric rule curve' }).click();
	await selectChoice(page, metric.getByRole('combobox', { name: 'Curve preset' }), {
		label: 'Bell'
	});
	await metric.getByRole('button', { name: 'Metric rule curve' }).click();
	await page.screenshot({ path: testInfo.outputPath('compact-interactions.png') });
	await openSection(page, 'Appearance');
	const sources = {
		hue: 'center-orbit-angle',
		saturation: 'speed-contrast',
		lightness: 'center-radial-speed'
	} as const;
	for (const [channel, source] of Object.entries(sources)) {
		const row = page.locator(`[data-channel="${channel}"]`);
		const name = channel[0].toUpperCase() + channel.slice(1);
		await expect(row.getByRole('combobox', { name: `${name} source` })).toBeVisible();
		await row.getByRole('combobox', { name: `${name} source` }).click();
		await expect(
			page.getByRole('listbox', { name: `${name} source` }).getByRole('option')
		).toHaveCount(16);
		await page.keyboard.press('Escape');
		await selectChoice(page, row.getByRole('combobox', { name: `${name} source` }), source);
		await row.getByRole('checkbox', { name: `Enable ${channel} mapping` }).check();
		await expect(row.getByRole('slider', { name: 'Strength', exact: true })).toBeVisible();
		await expect(row.getByRole('button', { name: `${name} curve`, exact: true })).toBeVisible();
	}
	const canvas = page.locator('canvas');
	for (const palette of ['Rainbow', 'Bands', 'Ocean', 'Chrome', 'Mono']) {
		await page.getByRole('button', { name: `${palette} palette`, exact: true }).click();
		await expect(
			page.getByRole('button', { name: `${palette} palette`, exact: true })
		).toHaveAttribute('aria-pressed', 'true');
	}
	await page.getByRole('button', { name: 'Rainbow palette', exact: true }).click();
	const rainbow = await canvas.screenshot();
	await page.getByRole('button', { name: 'Ocean palette', exact: true }).click();
	await expect.poll(async () => Buffer.compare(rainbow, await canvas.screenshot())).not.toBe(0);
	await page.screenshot({ path: testInfo.outputPath('compact-appearance.png') });
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const saved = await exportedScene(page);
	expect(saved.dynamics.timeScale).toBe(3);
	expect(saved.speciesRules).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				from: 'shoal',
				to: 'amber',
				behavior: 'chase',
				strength: 5,
				radius: 20
			}),
			expect.objectContaining({ from: 'shoal', to: '*', behavior: 'ignore', radius: null })
		])
	);
	expect(saved.species[0].metricRules[0]).toMatchObject({
		metric: 'speed-contrast',
		role: 'difference',
		behavior: 'mirror'
	});
	for (const [channel, source] of Object.entries(sources)) {
		expect(saved.species[0].visual[channel as 'hue' | 'saturation' | 'lightness']).toMatchObject({
			enabled: true,
			source
		});
	}
	expect(saved.visual.palette).toBe('ocean');
	await expect(clock).toHaveText(frozen);
});

test('custom choices support keyboard navigation, Escape and typeahead without advancing physics', async ({
	page
}) => {
	await openWorld(page);
	await pause(page);
	await openSection(page, 'Appearance');
	const clock = page.locator('.status-measures [data-tick]');
	const frozen = await clock.innerText();
	const source = page.getByRole('combobox', { name: 'Hue source', exact: true });
	await expect(source).toHaveAttribute('data-value', 'constant');
	const before = await interiorStagePixels(page);
	await source.focus();
	await page.keyboard.press('ArrowDown');
	const menu = page.getByRole('listbox', { name: 'Hue source', exact: true });
	await expect(menu).toBeVisible();
	await expect(menu).toBeFocused();
	await page.keyboard.press('End');
	await expect(menu).toHaveAttribute(
		'aria-activedescendant',
		(await menu.getByRole('option').last().getAttribute('id'))!
	);
	await page.keyboard.press('Home');
	await expect(menu).toHaveAttribute(
		'aria-activedescendant',
		(await menu.getByRole('option').first().getAttribute('id'))!
	);
	await page.keyboard.press('Escape');
	await expect(menu).not.toBeVisible();
	await expect(source).toBeFocused();
	await expect(source).toHaveAttribute('data-value', 'constant');
	await expect(clock).toHaveText(frozen);
	await expect.poll(async () => Buffer.compare(before, await interiorStagePixels(page))).toBe(0);
	// Printable keys navigate labels; they must not reach global simulation shortcuts.
	await page.keyboard.press('w');
	await expect(menu).toBeVisible();
	await expect(menu.locator('[role="option"][data-value="heading-azimuth"]')).toHaveClass(
		/highlighted/
	);
	await page.keyboard.press('Enter');
	await expect(menu).not.toBeVisible();
	await expect(source).toBeFocused();
	await expect(source).toHaveAttribute('data-value', 'heading-azimuth');
	await expect(page.getByRole('checkbox', { name: 'Enable hue mapping' })).toBeChecked();
	await expect(clock).toHaveText(frozen);
});

test('choice menus stay inside a short viewport and preserve focus when resized', async ({
	page
}) => {
	await page.setViewportSize({ width: 1000, height: 560 });
	await openWorld(page);
	await pause(page);
	await openSection(page, 'Appearance');
	const clock = page.locator('.status-measures [data-tick]');
	const frozen = await clock.innerText();
	const source = page.getByRole('combobox', { name: 'Lightness source', exact: true });
	await source.click();
	const menu = page.getByRole('listbox', { name: 'Lightness source', exact: true });
	await expect(menu).toBeVisible();
	const bounds = await menu.boundingBox();
	expect(bounds).toBeTruthy();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.y).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1000);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560);
	await expect(menu.getByRole('option')).toHaveCount(16);
	const last = menu.getByRole('option').last();
	await last.scrollIntoViewIfNeeded();
	await expect(last).toBeVisible();
	await expect(menu).toBeVisible();
	const selected = (await last.getAttribute('data-value'))!;
	await last.click();
	await expect(source).toHaveAttribute('data-value', selected);
	await expect(source).toBeFocused();
	await source.click();
	await expect(menu).toBeVisible();
	await page.setViewportSize({ width: 980, height: 540 });
	await expect(menu).not.toBeVisible();
	await expect(source).toBeFocused();
	await expect(source).toHaveAttribute('data-value', selected);
	await expect(clock).toHaveText(frozen);
});

test('desktop and mobile keep one continuous stage dock with reachable tools and framing', async ({
	page
}) => {
	await openWorld(page);
	await pause(page);
	for (const viewport of [
		{ width: 1440, height: 1000 },
		{ width: 393, height: 852 }
	]) {
		await page.setViewportSize(viewport);
		const dock = page.getByRole('toolbar', { name: 'Stage controls', exact: true });
		await expect(page.getByRole('toolbar')).toHaveCount(1);
		await expect(dock).toBeVisible();
		const bounds = await dock.boundingBox();
		expect(bounds).toBeTruthy();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
		expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
		expect(bounds!.height).toBeLessThanOrEqual(64);
		const playback = await dock
			.getByRole('group', { name: 'Simulation and capture' })
			.boundingBox();
		const tools = dock.getByRole('group', { name: 'Canvas interaction tools' });
		const toolBounds = await tools.boundingBox();
		expect(
			Math.abs(playback!.y + playback!.height / 2 - toolBounds!.y - toolBounds!.height / 2)
		).toBeLessThanOrEqual(5);
		for (const name of ['Look', 'Force', 'Obstacle', 'Inspect']) {
			await expect(tools.getByRole('button', { name, exact: true })).toBeVisible();
		}
		await tools.getByRole('button', { name: 'Force', exact: true }).click();
		await expect(tools.getByRole('button', { name: 'Force', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await dock.locator('summary[aria-label="More stage actions"]').click();
		await dock.getByRole('button', { name: /Reset framing/ }).click();
		await expect(dock.locator('.dock-menu')).not.toHaveAttribute('open');
		await tools.getByRole('button', { name: 'Look', exact: true }).click();
		await expect(tools.getByRole('button', { name: 'Look', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	}
});

test('scene rename survives saving and keyboard dismissal returns focus to its opener', async ({
	page
}) => {
	await openWorld(page);
	await pause(page);
	const clock = page.locator('.status-measures [data-tick]');
	const frozen = await clock.innerText();
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const name = page.getByRole('textbox', { name: 'Scene name', exact: true });
	await name.fill('Scene A');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Load Scene A', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Rename Scene A', exact: true }).click();
	const renameA = page.getByRole('textbox', { name: 'Rename Scene A', exact: true });
	await expect(renameA).toBeFocused();
	await renameA.fill('Scene B');
	await renameA.press('Enter');
	const renameB = page.getByRole('button', { name: 'Rename Scene B', exact: true });
	await expect(renameB).toBeFocused();
	await expect(page.getByRole('button', { name: 'Load Scene A', exact: true })).toHaveCount(0);
	await expect(name).toHaveValue('Scene B');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Load Scene B', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Load Scene A', exact: true })).toHaveCount(0);
	await renameB.click();
	const draft = page.getByRole('textbox', { name: 'Rename Scene B', exact: true });
	await draft.fill('Discard this draft');
	await draft.press('Escape');
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(renameB).toBeFocused();
	await expect(page.getByRole('button', { name: 'Load Scene B', exact: true })).toBeVisible();
	await expect(name).toHaveValue('Scene B');
	const saved = await exportedScene(page);
	expect(saved.name).toBe('Scene B');
	await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
	const more = page.locator('summary[aria-label="More stage actions"]');
	await more.focus();
	await page.keyboard.press('Space');
	await expect(page.locator('.dock-menu')).toHaveAttribute('open');
	await expect(page.getByRole('button', { name: 'Resume simulation', exact: true })).toBeEnabled();
	await expect(clock).toHaveText(frozen);
	await page.getByRole('button', { name: 'Browse scenes', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(page.locator('.dock-menu')).not.toHaveAttribute('open');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).not.toBeVisible();
	await expect(more).toBeFocused();
	await expect(clock).toHaveText(frozen);
});

for (const world of [
	{ kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' },
	{ kind: 'volume', shape: 'sphere', radius: 14 },
	{ kind: 'volume', shape: 'cylinder', radius: 12, halfHeight: 14 },
	{ kind: 'volume', shape: 'torus', majorRadius: 20, tubeRadius: 8 }
] satisfies WorldDefinition[]) {
	test(`${world.shape} volume: graphical domain choices and exported dimensions`, async ({
		page
	}) => {
		const scene = structuredClone(fixture) as unknown as SceneDefinition;
		scene.world = world;
		scene.visual.showBoundary = false;
		scene.visual.showGrid = false;
		await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
		await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
			timeout: 45000
		});
		await pause(page);
		// The domain belongs with the geometry, rather than occupying a permanent toolbar.
		await expect(page.getByRole('button', { name: 'Volume', exact: true })).toHaveCount(0);
		await openSection(page, 'World');
		const domain = page.getByRole('group', { name: 'Simulation domain' });
		await expect(domain.getByRole('button', { name: 'Volume', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(page.getByRole('group', { name: 'World shape' }).getByRole('button')).toHaveCount(
			4
		);
		await expect(worldTile(page, world.shape)).toHaveAttribute('aria-pressed', 'true');
		if (world.shape === 'sphere') await editWorldNumber(page, 'Sphere radius', 19);
		else if (world.shape === 'cylinder') {
			await editWorldNumber(page, 'Cylinder radius', 19);
			await editWorldNumber(page, 'Cylinder height', 34);
		} else if (world.shape === 'torus') {
			await editWorldNumber(page, 'Major radius', 24);
			await editWorldNumber(page, 'Tube radius', 9);
		} else await editWorldNumber(page, 'Width', 42);
		if (world.shape === 'box') {
			await page.getByRole('button', { name: 'Scenes', exact: true }).click();
			const edited = await exportedScene(page);
			expect(edited.world).toEqual({ ...world, halfExtents: [21, 12, 18] });
			await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
		}
		await domain.getByRole('button', { name: 'Surface', exact: true }).click();
		await expect(domain.getByRole('button', { name: 'Surface', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(worldTile(page, world.shape === 'box' ? 'sphere' : world.shape)).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await domain.getByRole('button', { name: 'Volume', exact: true }).click();
		if (world.shape === 'box') {
			// A box skin is not a supported surface. The sphere fallback keeps its
			// geometry when returning to a volume; selecting Box remains explicit.
			await expect(worldTile(page, 'sphere')).toHaveAttribute('aria-pressed', 'true');
			await worldTile(page, 'box').click();
			await expect(worldTile(page, 'box')).toHaveAttribute('aria-pressed', 'true');
			return;
		}
		await expect(worldTile(page, world.shape)).toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: 'Scenes', exact: true }).click();
		const exported = await exportedScene(page);
		expect(exported.world.kind).toBe('volume');
		expect(exported.world.shape).toBe(world.shape);
		if (exported.world.shape === 'sphere') expect(exported.world.radius).toBe(19);
		else if (exported.world.shape === 'cylinder') {
			expect(exported.world.radius).toBe(19);
			expect(exported.world.halfHeight).toBe(17);
		} else if (exported.world.shape === 'torus') {
			expect(exported.world.majorRadius).toBe(24);
			expect(exported.world.tubeRadius).toBe(9);
		} else if (exported.world.shape === 'box') expect(exported.world.halfExtents[0]).toBe(21);
		else throw new Error('Volume selector exported an unsupported shape.');
	});
}

test('world outline and subtle grid draw independently while physics is paused', async ({
	page
}) => {
	const scene = structuredClone(fixture) as unknown as SceneDefinition;
	scene.world = { kind: 'volume', shape: 'sphere', radius: 14 };
	scene.visual.showBoundary = false;
	scene.visual.showGrid = false;
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
	await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
		timeout: 45000
	});
	await pause(page);
	await openSection(page, 'World');
	const clock = page.locator('.status-measures [data-tick]');
	const frozenTick = (await clock.getAttribute('data-tick'))!;
	const outline = page.getByRole('checkbox', { name: 'Show world boundary' });
	const grid = page.getByRole('checkbox', { name: 'Show subtle grid' });
	await expect(outline).not.toBeChecked();
	await expect(grid).not.toBeChecked();
	const bare = await interiorStagePixels(page);
	await outline.check();
	await expect.poll(async () => Buffer.compare(bare, await interiorStagePixels(page))).not.toBe(0);
	await expect(grid).not.toBeChecked();
	await outline.uncheck();
	await expect.poll(async () => Buffer.compare(bare, await interiorStagePixels(page))).toBe(0);
	await grid.check();
	await expect.poll(async () => Buffer.compare(bare, await interiorStagePixels(page))).not.toBe(0);
	await expect(outline).not.toBeChecked();
	await expect(clock).toHaveAttribute('data-tick', frozenTick);
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const exported = await exportedScene(page);
	expect(exported.visual.showBoundary).toBe(false);
	expect(exported.visual.showGrid).toBe(true);
});

test('day mode changes stage, glass controls, menus and scene dialog without advancing physics', async ({
	page
}) => {
	await openWorld(page);
	await pause(page);
	await openSection(page, 'World');
	const clock = page.locator('.status-measures [data-tick]');
	const frozenTick = (await clock.getAttribute('data-tick'))!;
	const cabinet = page.locator('.laboratory');
	const nightPanel = await cabinet.evaluate((element) => getComputedStyle(element).backgroundColor);
	const nightStage = await interiorStagePixels(page);
	const boundary = page.getByRole('combobox', { name: 'Boundary', exact: true });
	await boundary.click();
	const list = page.getByRole('listbox', { name: 'Boundary', exact: true });
	const nightList = await list.evaluate((element) => ({
		color: getComputedStyle(element).color,
		background: getComputedStyle(element).backgroundColor
	}));
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const nightDialog = await page
		.getByRole('dialog')
		.evaluate((element) => getComputedStyle(element).backgroundColor);
	await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
	await page.getByRole('button', { name: 'Switch to day mode' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
	await expect(page.getByRole('button', { name: 'Switch to night mode' })).toBeVisible();
	await expect
		.poll(() => cabinet.evaluate((element) => getComputedStyle(element).backgroundColor))
		.not.toBe(nightPanel);
	await expect
		.poll(async () => Buffer.compare(nightStage, await interiorStagePixels(page)))
		.not.toBe(0);
	await boundary.click();
	await expect(list).toBeVisible();
	const dayList = await list.evaluate((element) => ({
		color: getComputedStyle(element).color,
		background: getComputedStyle(element).backgroundColor
	}));
	expect(dayList.color).not.toBe(nightList.color);
	expect(dayList.background).not.toBe(nightList.background);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	const dayDialog = await dialog.evaluate((element) => getComputedStyle(element).backgroundColor);
	expect(dayDialog).not.toBe('rgba(0, 0, 0, 0)');
	expect(dayDialog).not.toBe(nightDialog);
	const exported = await exportedScene(page);
	expect(exported.visual.theme).toBe('day');
	await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
	await page.getByRole('button', { name: 'Switch to night mode' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
	await expect(clock).toHaveAttribute('data-tick', frozenTick);
	await expect
		.poll(async () => Buffer.compare(nightStage, await interiorStagePixels(page)))
		.toBe(0);
});

test('inside a cylinder surface, agents remain pickable through the interior view', async ({
	page
}, testInfo) => {
	const world: WorldDefinition = { kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 14 };
	const scene = chartScene(world);
	scene.camera.distance = 5;
	scene.camera.pitch = 0.1;
	scene.camera.target = [0, 0, 0];
	scene.visual.showBoundary = true;
	scene.visual.showGrid = true;
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
	await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
		timeout: 45000
	});
	await pause(page);
	const bounds = (await page.locator('canvas').boundingBox())!;
	const camera = new StageCamera(scene.camera);
	camera.update(bounds.width / bounds.height);
	const candidate = initializePopulation(scene)
		.agents.map((agent) => {
			const projected = camera.project(agent.position);
			const point = {
				x: (projected[0] * 0.5 + 0.5) * bounds.width,
				y: (0.5 - projected[1] * 0.5) * bounds.height
			};
			const hit = camera.hit(projected[0], projected[1], world, [0, 1, 0], 0);
			return { agent, projected, point, hit };
		})
		.find(
			({ agent, projected, point, hit }) =>
				projected[2] > 0 &&
				projected[2] < 1 &&
				point.x > 400 &&
				point.x < 1000 &&
				point.y > 180 &&
				point.y < 700 &&
				hit &&
				worldDistance(world, agent.position, hit.position) < 0.02
		);
	expect(candidate).toBeTruthy();
	await page.getByRole('button', { name: 'Inspect', exact: true }).click();
	await page.locator('canvas').click({ position: candidate!.point });
	await expect(page.getByLabel('Selected agent inspector').locator('h2')).toContainText(
		`#${candidate!.agent.id}`
	);
	await page.screenshot({ path: testInfo.outputPath('inside-cylinder.png') });
	expect(errors).toEqual([]);
});
