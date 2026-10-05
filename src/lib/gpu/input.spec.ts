import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultScene } from '#lib/model';
import type { EngineTool } from './contracts';
import type { StageCamera } from './camera';
import { attachStageInput, type FieldPointer } from './input';

function setup() {
	const scene = createDefaultScene();
	let tool: EngineTool = 'force';
	const windowTarget = new EventTarget();
	const documentTarget = Object.assign(new EventTarget(), { hidden: false });
	vi.stubGlobal('window', windowTarget);
	vi.stubGlobal('document', documentTarget);
	const canvas = Object.assign(new EventTarget(), {
		focus: vi.fn(),
		setPointerCapture: vi.fn(),
		clientHeight: 500,
		getBoundingClientRect: () => ({
			left: 0,
			top: 0,
			right: 500,
			bottom: 500,
			width: 500,
			height: 500
		})
	});
	const camera = {
		position: [0, 10, 10],
		right: [1, 0, 0],
		up: [0, 1, 0],
		aspect: 1,
		hit: vi.fn((x, y, _world, _normal, depth) => ({ position: [x, depth, y], normal: null })),
		pan: vi.fn(),
		zoom: vi.fn(),
		orbit: vi.fn()
	};
	const fields: FieldPointer[] = [];
	const input = attachStageInput(
		canvas as unknown as HTMLCanvasElement,
		camera as unknown as StageCamera,
		{
			getScene: () => scene,
			getTool: () => tool,
			onField: (field) => fields.push(field),
			onChange: vi.fn(),
			onInspect: vi.fn(),
			onObstacle: vi.fn()
		}
	);
	const pointer = (type: string, options: Record<string, unknown> = {}) => {
		canvas.dispatchEvent(
			Object.assign(new Event(type), {
				clientX: 250,
				clientY: 250,
				pointerId: 1,
				pointerType: 'mouse',
				button: 0,
				buttons: type === 'pointerup' ? 0 : 1,
				altKey: false,
				shiftKey: false,
				...options
			})
		);
	};
	return {
		scene,
		input,
		pointer,
		camera,
		fields,
		canvas,
		windowTarget,
		documentTarget,
		setTool: (value: EngineTool) => {
			tool = value;
			input.refresh();
		}
	};
}

afterEach(() => vi.unstubAllGlobals());

describe('force pointer lifetime and world placement', () => {
	it('reprojects stationary hover after a placement-plane or camera edit, but skips unchanged queries', () => {
		const { input, pointer, scene, camera, fields } = setup();
		pointer('pointermove', { buttons: 0 });
		expect(fields.at(-1)).toEqual({ active: true, pressed: false, position: [0, 0, 0] });
		input.refresh();
		expect(camera.hit).toHaveBeenCalledTimes(1);
		scene.forces.depth = 3;
		input.refresh();
		expect(fields.at(-1)?.position).toEqual([0, 3, 0]);
		camera.position[0] = 1;
		input.refresh();
		expect(camera.hit).toHaveBeenCalledTimes(3);
		input.dispose();
	});
	it('touch release clears the field instead of leaving a persistent invisible force', () => {
		const { input, pointer, fields } = setup();
		pointer('pointerdown', { pointerType: 'touch' });
		expect(fields.at(-1)).toMatchObject({ active: true, pressed: true });
		pointer('pointerup', { pointerType: 'touch' });
		input.refresh();
		expect(fields.at(-1)).toMatchObject({ active: false, pressed: false });
		input.dispose();
	});
	it('captured dragging outside the canvas stops physics and the footprint', () => {
		const { input, pointer, fields } = setup();
		pointer('pointerdown');
		pointer('pointermove', { clientX: 700 });
		expect(fields.at(-1)).toMatchObject({ active: false, pressed: false });
		pointer('pointerup', { clientX: 700 });
		expect(fields.at(-1)?.active).toBe(false);
		input.dispose();
	});
	it('camera gestures suppress lingering forces and restore mouse hover after release', () => {
		const { input, pointer, fields, camera } = setup();
		pointer('pointermove', { buttons: 0 });
		pointer('pointerdown', { altKey: true });
		expect(fields.at(-1)?.active).toBe(false);
		pointer('pointermove', { clientX: 280, altKey: true });
		expect(camera.orbit).toHaveBeenCalled();
		expect(fields.at(-1)?.active).toBe(false);
		pointer('pointerup', { clientX: 280 });
		expect(fields.at(-1)).toMatchObject({ active: true, pressed: false });
		input.dispose();
	});
	it('two-finger camera gestures cannot resume a one-finger force mid-gesture', () => {
		const { input, pointer, fields } = setup();
		pointer('pointerdown', { pointerType: 'touch' });
		pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 300 });
		expect(fields.at(-1)?.active).toBe(false);
		pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 300 });
		pointer('pointermove', { pointerType: 'touch' });
		input.refresh();
		expect(fields.at(-1)?.active).toBe(false);
		input.dispose();
	});
	it('captured dragging over an overlay control cannot apply a force behind it', () => {
		const { input, pointer, fields, canvas, documentTarget } = setup();
		Object.assign(documentTarget, { elementFromPoint: () => canvas });
		pointer('pointerdown');
		expect(fields.at(-1)?.active).toBe(true);
		Object.assign(documentTarget, { elementFromPoint: () => new EventTarget() });
		pointer('pointermove', { clientX: 280 });
		expect(fields.at(-1)).toMatchObject({ active: false, pressed: false });
		input.dispose();
	});
	it('a dialog covering a stationary pointer suspends its field until the stage is exposed', () => {
		const { input, pointer, fields, canvas, documentTarget } = setup();
		Object.assign(documentTarget, { elementFromPoint: () => canvas });
		pointer('pointermove', { buttons: 0 });
		expect(fields.at(-1)?.active).toBe(true);
		Object.assign(documentTarget, { elementFromPoint: () => new EventTarget() });
		input.refresh();
		expect(fields.at(-1)).toMatchObject({ active: false, pressed: false });
		Object.assign(documentTarget, { elementFromPoint: () => canvas });
		input.refresh();
		expect(fields.at(-1)).toMatchObject({ active: true, pressed: false });
		input.dispose();
	});
	it('unexpected capture loss and hidden documents release pressed fields', () => {
		const { input, pointer, fields, canvas, documentTarget } = setup();
		pointer('pointerdown');
		canvas.dispatchEvent(Object.assign(new Event('lostpointercapture'), { pointerId: 1 }));
		input.refresh();
		expect(fields.at(-1)).toMatchObject({ active: false, pressed: false });
		pointer('pointerdown');
		documentTarget.hidden = true;
		documentTarget.dispatchEvent(new Event('visibilitychange'));
		input.refresh();
		expect(fields.at(-1)).toMatchObject({ active: false, pressed: false });
		input.dispose();
	});
	it('tool changes, pointer leave, cancellation and focus loss invalidate the field', () => {
		const { input, pointer, fields, canvas, setTool, windowTarget } = setup();
		pointer('pointermove', { buttons: 0 });
		setTool('look');
		expect(fields.at(-1)?.active).toBe(false);
		setTool('force');
		expect(fields.at(-1)?.active).toBe(true);
		canvas.dispatchEvent(new Event('pointerleave'));
		input.refresh();
		expect(fields.at(-1)?.active).toBe(false);
		pointer('pointerdown');
		pointer('pointercancel');
		expect(fields.at(-1)?.active).toBe(false);
		pointer('pointerdown');
		windowTarget.dispatchEvent(new Event('blur'));
		input.refresh();
		expect(fields.at(-1)).toMatchObject({ active: false, pressed: false });
		input.dispose();
	});
});
