import { test, expect } from '@playwright/test';
import type { SceneDefinition } from '#lib/model';
import { initializePopulation } from '../src/lib/model/population';
import { StageCamera } from '../src/lib/gpu/camera';
import fixture from './scene.json' with { type: 'json' };

test('single-agent telemetry has real curves, keyboard history and frozen paused sampling', async ({
	page
}) => {
	const scene = structuredClone(fixture) as unknown as SceneDefinition;
	scene.species = [scene.species[0]];
	scene.species[0].population = 1;
	scene.species[0].alignment = 0;
	scene.species[0].cohesion = 0;
	scene.species[0].separation = 0;
	scene.species[0].rebels.fraction = 0;
	scene.speciesRules = [];
	scene.dynamics.noise = 0;
	scene.dynamics.collision = 0;
	scene.dynamics.timeScale = 0.1;
	scene.visual.showBoundary = false;
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
	await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
		timeout: 45000
	});
	await page.getByRole('button', { name: 'Pause simulation' }).click();
	await expect(page.locator('.status-strip')).toContainText('PAUSED');
	const bounds = (await page.locator('canvas').boundingBox())!;
	const camera = new StageCamera(scene.camera);
	camera.update(bounds.width / bounds.height);
	const agent = initializePopulation(scene).agents[0];
	const point = camera.project(agent.position);
	await page.getByRole('button', { name: 'Inspect', exact: true }).click();
	await page.locator('canvas').click({
		position: {
			x: (point[0] * 0.5 + 0.5) * bounds.width,
			y: (0.5 - point[1] * 0.5) * bounds.height
		}
	});
	const inspector = page.getByLabel('Selected agent inspector');
	await expect(inspector.locator('h2')).toContainText(`#${agent.id}`);
	await expect(inspector).toHaveAttribute('data-samples', '1');
	await expect(inspector.getByRole('img', { name: /^Speed history/ })).toBeVisible();
	await expect(inspector.getByRole('img', { name: /^Acceleration history/ })).toBeVisible();
	const firstTick = (await inspector.getAttribute('data-selected-tick'))!;
	for (let sample = 2; sample <= 5; sample++) {
		await page.getByRole('button', { name: 'Advance one fixed simulation step' }).click();
		await expect(inspector).toHaveAttribute('data-samples', String(sample));
	}
	await page.waitForTimeout(650); // Several readbacks at one paused tick must not create history.
	await expect(inspector).toHaveAttribute('data-samples', '5');
	await page.getByRole('button', { name: 'Resume simulation' }).click();
	await expect
		.poll(async () => Number(await inspector.getAttribute('data-samples')))
		.toBeGreaterThanOrEqual(8);
	await page.getByRole('button', { name: 'Pause simulation' }).click();
	const clock = page.locator('.status-measures [data-tick]');
	await expect
		.poll(
			async () =>
				(await inspector.getAttribute('data-latest-tick')) ===
				(await clock.getAttribute('data-tick'))
		)
		.toBe(true);
	const newestTick = (await inspector.getAttribute('data-latest-tick'))!;
	const timeline = inspector.getByRole('slider', { name: 'History time' });
	await timeline.focus();
	await timeline.press('Home');
	await expect(inspector).toHaveAttribute('data-selected-tick', firstTick);
	await expect(timeline).toHaveAttribute('aria-valuetext', new RegExp(`tick ${firstTick}$`));
	await timeline.press('ArrowRight');
	await expect(inspector).not.toHaveAttribute('data-selected-tick', firstTick);
	await inspector.getByRole('button', { name: 'Go live' }).click();
	await expect(inspector).toHaveAttribute('data-selected-tick', newestTick);
	await page.getByRole('button', { name: 'Restart simulation from the same seed' }).click();
	await expect(inspector).toHaveCount(0);
	await expect(page.locator('.status-measures [data-tick]')).toHaveAttribute('data-tick', '0');
});
