import type { SceneDefinition } from '#lib/model/types';

/** Presentation changes never change the physical scene or recorded metric colors. */
export function stageBackground(visual: SceneDefinition['visual']): string {
	return visual.theme === 'day' ? (visual.dayBackground ?? '#e7eff3') : visual.background;
}

export function linearBackground(visual: SceneDefinition['visual']): readonly number[] {
	const hex = stageBackground(visual).slice(1);
	return [0, 2, 4].map((offset) => {
		const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
}
