import { test, expect } from '@playwright/test';
import type { SceneDefinition } from '#lib/model';
import fixture from './scene.json' with { type: 'json' };

for (const theme of ['night', 'day'] as const) {
	test(`bloom visibly changes ordinary agent colors in ${theme} mode while paused`, async ({
		page
	}) => {
		const scene = structuredClone(fixture) as unknown as SceneDefinition;
		scene.visual.theme = theme;
		scene.visual.bloom = false;
		scene.dynamics.timeScale = 0.01;
		for (const species of scene.species) {
			species.visual.hsl = [0.47, 0.65, 0.62];
			for (const channel of ['hue', 'saturation', 'lightness'] as const)
				species.visual[channel].enabled = false;
			species.trail.length = 0;
		}
		await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
		const pause = page.getByRole('button', { name: 'Pause simulation', exact: true });
		await expect(pause).toBeEnabled({ timeout: 45000 });
		await pause.click();
		await expect(page.locator('.status-strip')).toContainText('PAUSED');
		const clock = page.locator('.status-measures [data-tick]');
		const frozenTick = (await clock.getAttribute('data-tick'))!;
		await page.getByRole('button', { name: 'Appearance', exact: true }).click();
		const display = page
			.locator('details.control-group')
			.filter({ has: page.locator('summary').getByText('Display', { exact: true }) });
		if ((await display.getAttribute('open')) === null) await display.locator('summary').click();
		const bloom = page.getByRole('checkbox', { name: 'Bloom', exact: true });
		await expect(bloom).not.toBeChecked();
		const pixels = () => page.screenshot({ clip: { x: 24, y: 120, width: 1000, height: 720 } });
		const before = await pixels();
		await bloom.check();
		await expect.poll(async () => Buffer.compare(before, await pixels())).not.toBe(0);
		await bloom.uncheck();
		await expect.poll(async () => Buffer.compare(before, await pixels())).toBe(0);
		await expect(clock).toHaveAttribute('data-tick', frozenTick);
	});
}
