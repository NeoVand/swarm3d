import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { SceneDefinition } from '#lib/model';
import { initializePopulation } from '../src/lib/model/population';
import { StageCamera } from '../src/lib/gpu/camera';
import fixture from './scene.json' with { type: 'json' };

async function exportSettings(page: Page): Promise<SceneDefinition> {
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const file = await download;
	const scene = JSON.parse(await readFile((await file.path())!, 'utf8')) as SceneDefinition;
	await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
	return scene;
}

test('pan retains the orbit pivot, survives scene export, and shifted agent inspection remains aligned', async ({
	page
}, testInfo) => {
	const scene = structuredClone(fixture) as unknown as SceneDefinition;
	scene.species = [scene.species[0]];
	const species = scene.species[0];
	species.population = 40;
	species.speed = 0.1;
	species.cruiseSpeed = 0.1;
	species.alignment = 0;
	species.cohesion = 0;
	species.separation = 0;
	species.rebels.fraction = 0;
	scene.speciesRules = [];
	scene.dynamics.timeScale = 0.01;
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.visual.theme = 'night';
	scene.visual.showBoundary = true;
	scene.visual.bloom = false;
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
	await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
		timeout: 45000
	});
	await page.getByRole('button', { name: 'Pause simulation' }).click();
	await expect(page.locator('.status-strip')).toContainText('PAUSED');
	await page.getByRole('button', { name: 'Restart simulation from the same seed' }).click();
	const clock = page.locator('.status-measures [data-tick]');
	await expect(clock).toHaveAttribute('data-tick', '0');
	await page.getByRole('button', { name: 'Look', exact: true }).click();
	const canvas = page.locator('canvas'),
		bounds = (await canvas.boundingBox())!;
	const before = await canvas.screenshot();
	await page.mouse.move(bounds.x + 650, bounds.y + 450);
	await page.mouse.down({ button: 'right' });
	await page.mouse.move(bounds.x + 740, bounds.y + 495, { steps: 12 });
	await page.mouse.up({ button: 'right' });
	await expect.poll(async () => Buffer.compare(before, await canvas.screenshot())).not.toBe(0);
	const panned = await exportSettings(page);
	expect(panned.camera.target).toEqual(scene.camera.target);
	expect(panned.camera.yaw).toBe(scene.camera.yaw);
	expect(panned.camera.pitch).toBe(scene.camera.pitch);
	expect(panned.camera.pan![0]).toBeCloseTo(180 / bounds.height, 6);
	expect(panned.camera.pan![1]).toBeCloseTo(-90 / bounds.height, 6);
	const beforeOrbit = await canvas.screenshot();
	await page.mouse.move(bounds.x + 700, bounds.y + 500);
	await page.mouse.down();
	await page.mouse.move(bounds.x + 810, bounds.y + 450, { steps: 12 });
	await page.mouse.up();
	await expect.poll(async () => Buffer.compare(beforeOrbit, await canvas.screenshot())).not.toBe(0);
	const rotated = await exportSettings(page);
	expect(rotated.camera.target).toEqual(scene.camera.target);
	expect(rotated.camera.pan).toEqual(panned.camera.pan);
	expect(rotated.camera.yaw).toBeCloseTo(scene.camera.yaw - 110 * 0.006, 6);
	expect(rotated.camera.pitch).toBeCloseTo(scene.camera.pitch - 50 * 0.006, 6);
	await expect(clock).toHaveAttribute('data-tick', '0');
	const camera = new StageCamera(rotated.camera);
	const unpanned = new StageCamera({ ...rotated.camera, pan: [0, 0] });
	camera.update(bounds.width / bounds.height);
	unpanned.update(bounds.width / bounds.height);
	const pivot = camera.project(scene.camera.target);
	expect(pivot[0]).toBeCloseTo(panned.camera.pan![0] / camera.aspect, 6);
	expect(pivot[1]).toBeCloseTo(panned.camera.pan![1], 6);
	const candidates = initializePopulation(scene).agents.map((agent) => {
		const projected = camera.project(agent.position);
		return {
			agent,
			depth: projected[2],
			x: (projected[0] * 0.5 + 0.5) * bounds.width,
			y: (0.5 - projected[1] * 0.5) * bounds.height
		};
	});
	const selected = candidates.find(
		(candidate) =>
			candidate.depth > 0 &&
			candidate.depth < 1 &&
			candidate.x > 460 &&
			candidate.x < 1060 &&
			candidate.y > 180 &&
			candidate.y < 740 &&
			candidates.every(
				(other) =>
					other === candidate || Math.hypot(other.x - candidate.x, other.y - candidate.y) > 30
			)
	);
	expect(selected).toBeTruthy();
	const unshifted = unpanned.project(selected!.agent.position);
	expect(
		Math.hypot(
			selected!.x - (unshifted[0] * 0.5 + 0.5) * bounds.width,
			selected!.y - (0.5 - unshifted[1] * 0.5) * bounds.height
		)
	).toBeGreaterThan(75);
	await page.getByRole('button', { name: 'Inspect', exact: true }).click();
	await canvas.click({ position: { x: selected!.x, y: selected!.y } });
	await expect(page.getByLabel('Selected agent inspector').locator('h2')).toContainText(
		`#${selected!.agent.id}`
	);
	await expect(clock).toHaveAttribute('data-tick', '0');
	await page.screenshot({ path: testInfo.outputPath('panned-orbit-inspection.png') });
	expect(errors).toEqual([]);
});
