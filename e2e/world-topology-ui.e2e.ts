import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { SceneDefinition } from '#lib/model';
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
		['genus2', 'Genus 2 torus']
	] as const) {
		const choice = choices.getByRole('button', { name: `${label} world`, exact: true });
		await choice.click();
		await expect(choice).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.stage-domain-label')).toContainText(label.toLowerCase(), {
			ignoreCase: true
		});
		const scale = page.getByRole('spinbutton', { name: 'Surface scale value', exact: true });
		await scale.fill('19');
		await scale.press('Enter');
		await expect(page.getByRole('slider', { name: 'Surface scale', exact: true })).toHaveValue(
			'19'
		);
		const exported = await exportSettings(page);
		expect(exported.world).toEqual({ kind: 'surface', shape, radius: 19 });
		await expect
			.poll(async () => Buffer.compare(previousCanvas, await interiorStagePixels(page)))
			.not.toBe(0);
		previousCanvas = await interiorStagePixels(page);
		await page.screenshot({ path: testInfo.outputPath(`${shape}-world.png`) });
		await page.locator('.world-reference > summary[aria-label="World geometry guide"]').click();
		await expect(page.locator('.surface-diagram > svg')).toHaveAccessibleName(/.+/);
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
