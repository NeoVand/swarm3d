import { test, expect } from '@playwright/test';
import type { SceneDefinition } from '#lib/model';
import fixture from './scene.json' with { type: 'json' };

test('the flock logo continues while paused and crosses every loop without a jump', async ({
	page
}) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	const scene = structuredClone(fixture) as unknown as SceneDefinition;
	scene.dynamics.timeScale = 0.01;
	for (const species of scene.species) {
		species.population = 24;
		species.trail.length = 0;
	}
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
	const pause = page.getByRole('button', { name: 'Pause simulation', exact: true });
	await expect(pause).toBeEnabled({ timeout: 45000 });
	await pause.click();
	const logo = page.locator('.lab-brand .swarm-logo');
	await expect(logo.locator('animateMotion')).toHaveCount(6);
	const loop = await logo.evaluate((element) => {
		const svg = element as SVGSVGElement;
		const bird = svg.querySelector('[data-logo-agent="0"]') as SVGGraphicsElement;
		svg.pauseAnimations();
		const sample = (time: number) => {
			svg.setCurrentTime(time);
			const matrix = bird.getCTM()!;
			return { x: matrix.e, y: matrix.f, heading: Math.atan2(matrix.b, matrix.a) };
		};
		return {
			before: sample(11.995),
			after: sample(12.005),
			repeat: sample(36.005),
			middle: sample(15)
		};
	});
	expect(Math.hypot(loop.before.x - loop.after.x, loop.before.y - loop.after.y)).toBeLessThan(0.15);
	expect(Math.hypot(loop.after.x - loop.repeat.x, loop.after.y - loop.repeat.y)).toBeLessThan(0.01);
	expect(Math.abs(loop.before.heading - loop.after.heading)).toBeLessThan(0.015);
	expect(Math.hypot(loop.after.x - loop.middle.x, loop.after.y - loop.middle.y)).toBeGreaterThan(5);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(logo.locator('animateMotion')).toHaveCount(0);
	await expect(logo.locator('[data-logo-agent="0"]')).toHaveAttribute(
		'transform',
		/translate\(.+\) rotate\(.+\)/
	);
});
