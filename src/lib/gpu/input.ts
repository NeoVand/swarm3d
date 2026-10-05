import type { SceneDefinition, Vec3 } from '#lib/model';
import type { EngineTool } from './contracts';
import { StageCamera } from './camera';

export interface FieldPointer {
	active: boolean;
	position: Vec3;
	pressed: boolean;
}

export interface StageInput {
	/** Reproject a stationary pointer after camera, world, or placement-plane changes. */
	refresh(): void;
	dispose(): void;
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
): StageInput {
	const pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
	let previousPinch = 0;
	let moved = false;
	let multiTouch = false;
	let lastPaint: { position: Vec3; time: number } | null = null;
	const controller = new AbortController();
	const eventOptions = { signal: controller.signal };
	let hover: { x: number; y: number; type: string; suppressed: boolean } | null = null;
	let field: FieldPointer = { active: false, position: [0, 0, 0], pressed: false };
	let previousQuery: { world: SceneDefinition['world']; values: number[] } | null = null;
	const publishField = (value: FieldPointer) => {
		if (
			field.active === value.active &&
			field.pressed === value.pressed &&
			field.position.every((v, i) => v === value.position[i])
		)
			return;
		field = value;
		options.onField(value);
	};
	const clearField = () => {
		previousQuery = null;
		publishField({ active: false, position: [0, 0, 0], pressed: false });
	};
	const locate = (point: { x: number; y: number }) => {
		const bounds = canvas.getBoundingClientRect();
		const scene = options.getScene();
		if (
			bounds.width <= 0 ||
			bounds.height <= 0 ||
			point.x < bounds.left ||
			point.x > bounds.right ||
			point.y < bounds.top ||
			point.y > bounds.bottom
		)
			return null;
		// Pointer capture keeps dispatching to the canvas even over laboratory controls.
		// A field must not remain active behind a control that owns this screen point.
		if (
			typeof document.elementFromPoint === 'function' &&
			document.elementFromPoint(point.x, point.y) !== canvas
		)
			return null;
		const x = ((point.x - bounds.left) / bounds.width) * 2 - 1;
		const y = 1 - ((point.y - bounds.top) / bounds.height) * 2;
		return camera.hit(
			x,
			y,
			scene.world,
			scene.forces.workPlane.normal,
			scene.forces.depth + scene.forces.workPlane.offset
		);
	};
	const rememberPointer = (event: PointerEvent) => {
		hover = {
			x: event.clientX,
			y: event.clientY,
			type: event.pointerType,
			suppressed: event.altKey || event.shiftKey || (event.buttons & 6) !== 0
		};
		previousQuery = null;
	};
	const refresh = () => {
		if (
			options.getTool() !== 'force' ||
			!hover ||
			hover.suppressed ||
			multiTouch ||
			(hover.type === 'touch' && pointers.size === 0)
		) {
			clearField();
			return;
		}
		// A popover or modal can cover a stationary pointer without a pointer event.
		if (
			typeof document.elementFromPoint === 'function' &&
			document.elementFromPoint(hover.x, hover.y) !== canvas
		) {
			clearField();
			return;
		}
		const scene = options.getScene();
		const values = [
			hover.x,
			hover.y,
			...camera.position,
			...camera.right,
			...camera.up,
			camera.aspect,
			...scene.forces.workPlane.normal,
			scene.forces.depth + scene.forces.workPlane.offset,
			Number(pointers.size > 0)
		];
		if (
			previousQuery?.world === scene.world &&
			previousQuery.values.every((value, index) => value === values[index])
		)
			return;
		previousQuery = { world: scene.world, values };
		const hit = locate(hover);
		publishField({
			active: !!hit,
			position: hit?.position ?? [0, 0, 0],
			pressed: !!hit && pointers.size > 0
		});
	};
	const updateField = (event: PointerEvent) => {
		rememberPointer(event);
		if (event.type === 'pointercancel') hover = null;
		refresh();
	};
	const pinchDistance = () => {
		const pair = [...pointers.values()];
		return pair.length === 2 ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
	};
	canvas.addEventListener(
		'pointerdown',
		(event) => {
			canvas.focus({ preventScroll: true });
			rememberPointer(event);
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
			rememberPointer(event);
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
					const hit = locate({ x: event.clientX, y: event.clientY }),
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
			if (tool === 'force' && (multiTouch || hover?.suppressed)) clearField();
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
				const hit = locate({ x: event.clientX, y: event.clientY });
				if (hit) options.onObstacle(hit.position, hit.normal);
			}
		}
		pointers.delete(event.pointerId);
		previousPinch = pinchDistance();
		if (event.type === 'pointercancel' || event.pointerType === 'touch') {
			hover = null;
			clearField();
		} else if (options.getTool() === 'force') updateField(event);
		options.onChange();
	};
	canvas.addEventListener('pointerup', finish, eventOptions);
	canvas.addEventListener('pointercancel', finish, eventOptions);
	canvas.addEventListener(
		'lostpointercapture',
		(event) => {
			if (pointers.delete(event.pointerId)) {
				hover = null;
				clearField();
			}
		},
		eventOptions
	);
	canvas.addEventListener(
		'pointerleave',
		() => {
			hover = null;
			clearField();
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
	const deactivate = () => {
		pointers.clear();
		hover = null;
		clearField();
	};
	window.addEventListener('blur', deactivate, eventOptions);
	document.addEventListener(
		'visibilitychange',
		() => {
			if (document.hidden) deactivate();
		},
		eventOptions
	);
	return {
		refresh,
		dispose() {
			controller.abort();
			pointers.clear();
			hover = null;
		}
	};
}
