import type { SceneDefinition, Vec3 } from '#lib/model';
import type { EngineTool } from './contracts';
import { StageCamera } from './camera';

export interface FieldPointer {
	active: boolean;
	position: Vec3;
	pressed: boolean;
}

export function attachStageInput(
	canvas: HTMLCanvasElement,
	camera: StageCamera,
	options: {
		getScene(): SceneDefinition;
		getTool(): EngineTool;
		onField(field: FieldPointer): void;
		onInspect(x: number, y: number): void;
		onObstacle(position: Vec3, normal: Vec3 | null, drag?: boolean): void;
		onChange(): void;
	}
) {
	const pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
	let previousPinch = 0;
	let moved = false;
	let multiTouch = false;
	let lastPaint: { position: Vec3; time: number } | null = null;
	const controller = new AbortController();
	const eventOptions = { signal: controller.signal };
	const locate = (event: PointerEvent) => {
		const bounds = canvas.getBoundingClientRect();
		const scene = options.getScene();
		const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
		const y = 1 - ((event.clientY - bounds.top) / bounds.height) * 2;
		return camera.hit(
			x,
			y,
			scene.world,
			scene.forces.workPlane.normal,
			scene.forces.depth + scene.forces.workPlane.offset
		);
	};
	const updateField = (event: PointerEvent) => {
		if (multiTouch || event.type === 'pointercancel') {
			options.onField({ active: false, position: [0, 0, 0], pressed: false });
			return;
		}
		const hit = locate(event);
		options.onField({
			active: !!hit,
			position: hit?.position ?? [0, 0, 0],
			pressed: pointers.has(event.pointerId)
		});
	};
	const pinchDistance = () => {
		const pair = [...pointers.values()];
		return pair.length === 2 ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
	};
	canvas.addEventListener(
		'pointerdown',
		(event) => {
			canvas.focus({ preventScroll: true });
			if (pointers.size === 0) {
				moved = false;
				multiTouch = false;
				lastPaint = null;
			}
			pointers.set(event.pointerId, {
				x: event.clientX,
				y: event.clientY,
				startX: event.clientX,
				startY: event.clientY
			});
			if (pointers.size > 1) multiTouch = true;
			canvas.setPointerCapture(event.pointerId);
			previousPinch = pinchDistance();
			if (options.getTool() === 'force') updateField(event);
		},
		eventOptions
	);
	canvas.addEventListener(
		'pointermove',
		(event) => {
			const previous = pointers.get(event.pointerId);
			const tool = options.getTool();
			if (previous) {
				const dx = event.clientX - previous.x,
					dy = event.clientY - previous.y;
				if (Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY) > 3)
					moved = true;
				pointers.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
				if (pointers.size === 2) {
					const pinch = pinchDistance();
					if (previousPinch > 0 && pinch > 0) camera.zoom(Math.log(previousPinch / pinch) * 1000);
					camera.pan(dx / 2, dy / 2, canvas.clientHeight);
					previousPinch = pinch;
				} else if (event.buttons === 2 || event.buttons === 4 || event.shiftKey)
					camera.pan(dx, dy, canvas.clientHeight);
				else if (tool === 'look' || event.altKey) camera.orbit(dx, dy);
				else if (tool === 'force') updateField(event);
				else if (tool === 'obstacle' && moved && !multiTouch) {
					const hit = locate(event),
						now = performance.now();
					if (
						hit &&
						(!lastPaint ||
							(now - lastPaint.time >= 125 &&
								Math.hypot(...hit.position.map((v, i) => v - lastPaint!.position[i])) >= 0.5))
					) {
						lastPaint = { position: hit.position, time: now };
						options.onObstacle(hit.position, hit.normal, true);
					}
				}
			} else if (tool === 'force') updateField(event);
			options.onChange();
		},
		eventOptions
	);
	const finish = (event: PointerEvent) => {
		if (
			!moved &&
			!multiTouch &&
			pointers.size === 1 &&
			event.type === 'pointerup' &&
			event.button === 0
		) {
			if (options.getTool() === 'inspect') options.onInspect(event.clientX, event.clientY);
			if (options.getTool() === 'obstacle') {
				const hit = locate(event);
				if (hit) options.onObstacle(hit.position, hit.normal);
			}
		}
		pointers.delete(event.pointerId);
		previousPinch = pinchDistance();
		if (options.getTool() === 'force') updateField(event);
		options.onChange();
	};
	canvas.addEventListener('pointerup', finish, eventOptions);
	canvas.addEventListener('pointercancel', finish, eventOptions);
	canvas.addEventListener(
		'pointerleave',
		() => {
			if (!pointers.size) options.onField({ active: false, position: [0, 0, 0], pressed: false });
		},
		eventOptions
	);
	canvas.addEventListener(
		'wheel',
		(event) => {
			event.preventDefault();
			camera.zoom(event.deltaY);
			options.onChange();
		},
		{ ...eventOptions, passive: false }
	);
	canvas.addEventListener('contextmenu', (event) => event.preventDefault(), eventOptions);
	return () => {
		controller.abort();
		pointers.clear();
	};
}
