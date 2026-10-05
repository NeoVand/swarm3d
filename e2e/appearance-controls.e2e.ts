import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { SceneDefinition } from '#lib/model';
import { createDefaultScene } from '#lib/model';
import fixture from './scene.json' with { type: 'json' };

async function openAppearance(page: Page) {
	const scene = structuredClone(fixture) as unknown as SceneDefinition;
	scene.visual.theme = 'night';
	await page.goto('/#scene=' + Buffer.from(JSON.stringify(scene)).toString('base64url'));
	await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeEnabled({
		timeout: 45000
	});
	await page.getByRole('button', { name: 'Pause simulation' }).click();
	await expect(page.locator('.status-strip')).toContainText('PAUSED');
	await page.getByRole('button', { name: 'Appearance', exact: true }).click();
}

async function exportSettings(page: Page): Promise<SceneDefinition> {
	await page.getByRole('button', { name: 'Scenes', exact: true }).click();
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const file = await download;
	return JSON.parse(await readFile((await file.path())!, 'utf8'));
}

async function previewBackground(page: Page, value: string) {
	// The native picker emits input while open, and change only when it closes.
	// Exercise the live event alone so a change-only handler cannot pass this check.
	await page.getByLabel('Background', { exact: true }).evaluate((element, color) => {
		const input = element as HTMLInputElement;
		input.focus();
		input.value = color;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, value);
}

test('constant saturation reaches zero, repaints paused bodies, and preserves the other species', async ({
	page
}) => {
	await openAppearance(page);
	const saturation = page.locator('[data-channel="saturation"]');
	const source = saturation.getByRole('combobox', { name: 'Saturation source', exact: true });
	await expect(source).toContainText('Constant');
	const amount = saturation.getByRole('slider', { name: 'Saturation', exact: true });
	await expect(amount).toHaveAttribute('min', '0');
	await expect(amount).toHaveValue('68');
	const clock = page.locator('.status-measures [data-tick]');
	await expect(clock).toContainText(/\d/);
	const frozen = await clock.innerText();
	let colored = await page.locator('canvas').screenshot();
	await expect
		.poll(async () => {
			const next = await page.locator('canvas').screenshot();
			const stable = Buffer.compare(colored, next) === 0;
			colored = next;
			return stable;
		})
		.toBe(true);
	const number = saturation.getByRole('spinbutton', { name: 'Saturation value' });
	await number.fill('0');
	await number.press('Enter');
	await expect(amount).toHaveValue('0');
	await expect(number).toHaveValue('0');
	await expect(saturation).toContainText('0% · grayscale.');
	await expect
		.poll(async () => Buffer.compare(colored, await page.locator('canvas').screenshot()))
		.not.toBe(0);
	await expect(clock).toHaveText(frozen);
	const saved = await exportSettings(page);
	expect(saved.species[0].visual.hsl[1]).toBe(0);
	expect(saved.species[0].visual.saturation).toMatchObject({
		source: 'constant',
		enabled: false
	});
	expect(saved.species[1].visual.hsl).toEqual(fixture.species[1].visual.hsl);
});

test('background input previews immediately and a long picker gesture has one undo', async ({
	page
}) => {
	await openAppearance(page);
	const picker = page.getByLabel('Background', { exact: true });
	const undo = page.getByRole('button', { name: 'Undo settings change', exact: true });
	// Loading a shared scene is itself undoable. A picker session must add exactly
	// one newer entry without consuming or merging with that existing load entry.
	await expect(undo).toBeEnabled();
	const baseline = await exportSettings(page);
	await page.keyboard.press('Escape');
	const before = await page.locator('canvas').screenshot();
	await previewBackground(page, '#28445c');
	await expect(page.locator('.swarm-app')).toHaveCSS('--scene-background', '#28445c');
	await expect(picker).toBeFocused();
	await expect
		.poll(async () => Buffer.compare(before, await page.locator('canvas').screenshot()))
		.not.toBe(0);
	// Deliberately exceed the regular settings grouping interval during one edit.
	await page.waitForTimeout(450);
	await previewBackground(page, '#73527a');
	await expect(page.locator('.swarm-app')).toHaveCSS('--scene-background', '#73527a');
	await expect(picker).toBeFocused();
	await picker.dispatchEvent('change');
	await picker.press('Tab');
	await undo.click();
	await expect(picker).toHaveValue(fixture.visual.background);
	await expect(page.locator('.swarm-app')).toHaveCSS(
		'--scene-background',
		fixture.visual.background
	);
	await expect(undo).toBeEnabled();
	const saved = await exportSettings(page);
	expect(saved).toEqual(baseline);
	await page.keyboard.press('Escape');
	await undo.click();
	await expect(undo).toBeDisabled();
	const initial = await exportSettings(page);
	expect(initial.id).toBe(createDefaultScene().id);
});

test('day background previews use the selected color and leave the night background intact', async ({
	page
}) => {
	await openAppearance(page);
	await page.getByRole('button', { name: 'Switch to day mode' }).click();
	const picker = page.getByLabel('Background', { exact: true });
	await expect(picker).toHaveValue('#e7eff3');
	await previewBackground(page, '#dbe4ce');
	await expect(page.locator('.swarm-app')).toHaveCSS('--scene-background', '#dbe4ce');
	await expect(picker).toBeFocused();
	await picker.dispatchEvent('change');
	await picker.press('Tab');
	await page.getByRole('button', { name: 'Switch to night mode' }).click();
	await expect(picker).toHaveValue(fixture.visual.background);
	await page.getByRole('button', { name: 'Switch to day mode' }).click();
	await expect(picker).toHaveValue('#dbe4ce');
	const saved = await exportSettings(page);
	expect(saved.visual.theme).toBe('day');
	expect(saved.visual.dayBackground).toBe('#dbe4ce');
	expect(saved.visual.background).toBe(fixture.visual.background);
});
