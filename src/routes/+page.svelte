<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		createDefaultScene,
		decodeSceneShare,
		discoverScene,
		exportScene,
		importScene,
		maxSurfaceObstacleRadius,
		sceneRepository,
		sceneShareUrl,
		torusChart,
		torusComponents,
		torusLocalPoint,
		torusPoint,
		validateScene,
		worldDistance,
		worldExp,
		worldInteractionLimit,
		type SavedScene,
		type Vec3,
		type SceneDefinition
	} from '#lib/model';
	import { createEngine, type Engine } from '#lib/gpu/engine';
	import type { EngineStats, EngineTool, InspectionSample } from '#lib/gpu/contracts';
	import Icon from '#lib/components/Icon.svelte';
	import Parameter from '#lib/components/Parameter.svelte';
	import Select from '#lib/components/Select.svelte';
	import Laboratory from '#lib/components/Laboratory.svelte';
	import SceneLibrary from '#lib/components/SceneLibrary.svelte';
	import Inspector from '#lib/components/Inspector.svelte';
	import SwarmLogo from '#lib/components/SwarmLogo.svelte';
	import { appendInspectionHistory } from '#lib/inspection-history';
	import { stageBackground } from '#lib/gpu/appearance';
	import HelpDialog from '#lib/components/HelpDialog.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import Notification from '#lib/components/Notification.svelte';
	import { SHORTCUTS } from '#lib/components/shortcuts';
	let scene = $state.raw<SceneDefinition>(createDefaultScene());
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let error = $state('');
	let retry = $state(0);
	let paused = $state(false);
	let tool = $state<EngineTool>('look');
	let labOpen = $state(true);
	let section = $state('flocking');
	let libraryOpen = $state(false);
	let helpOpen = $state(false);
	let tour = $state(false);
	let welcome = $state(false);
	let shareUrl = $state('');
	let saved = $state.raw<SavedScene[]>([]);
	let stats = $state.raw<EngineStats | null>(null);
	let inspection = $state.raw<InspectionSample | null>(null);
	let inspectionHistory = $state.raw<readonly InspectionSample[]>([]);
	let recording = $state(false);
	let recordingPending = $state(false);
	let saving = $state(false);
	let stageActions: HTMLDetailsElement | undefined;
	let recordingSeconds = $state(0);
	let obstacleMode = $state<'place' | 'erase'>('place');
	let obstacleShape = $state<'sphere' | 'box' | 'ring'>('sphere');
	let obstacleSize = $state(1.5);
	let ringRadius = $state(4);
	let toast = $state<{ message: string; action?: string; run?: () => void } | null>(null);
	let undoStack = $state.raw<SceneDefinition[]>([]);
	let engine: Engine | null = null;
	let canvas: HTMLCanvasElement | null = null;
	let recorder: MediaRecorder | null = null;
	let recordingStream: MediaStream | null = null;
	let recordingTimer: ReturnType<typeof setInterval> | undefined;
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	let lastChange = 0;
	let editSnapshot: SceneDefinition | null = null;
	let editRecorded = false;
	let disposed = false;
	let renderPopulation = $derived(scene.species.reduce((sum, item) => sum + item.population, 0));
	let modalOpen = $derived(libraryOpen || helpOpen || Boolean(shareUrl));
	let obstacleLimit = $derived(
		Math.min(
			8,
			scene.world.kind === 'surface' && scene.world.shape === 'torus' && obstacleMode === 'place'
				? maxSurfaceObstacleRadius(scene)
				: worldInteractionLimit(scene.world) - 0.01
		)
	);
	let surfaceBrushLimit = $derived(
		scene.world.kind === 'surface' && scene.world.shape === 'torus'
			? maxSurfaceObstacleRadius(scene)
			: worldInteractionLimit(scene.world) - 0.01
	);
	let ringLimit = $derived(Math.min(12, (worldInteractionLimit(scene.world) * 2) / 3));
	let behindTarget = $derived(
		status === 'ready' &&
			!paused &&
			stats !== null &&
			stats.tick > 0 &&
			stats.realTimeFactor < scene.dynamics.timeScale * 0.85
	);
	let runLabel = $derived(
		status === 'error'
			? 'UNAVAILABLE'
			: status === 'loading'
				? 'INITIALIZING'
				: paused
					? 'PAUSED'
					: behindTarget
						? 'LIVE · BELOW TARGET'
						: scene.dynamics.timeScale < 0.999
							? 'LIVE · SLOW MOTION'
							: 'LIVE'
	);
	const tools: { id: EngineTool; label: string; key: string; hint: string }[] = [
		{
			id: 'look',
			label: 'Look',
			key: '1',
			hint: 'Drag to orbit · wheel to zoom · right-drag to pan'
		},
		{ id: 'force', label: 'Force', key: '2', hint: 'Hover or drag to influence · press to boost' },
		{
			id: 'obstacle',
			label: 'Obstacle',
			key: '3',
			hint: 'Tap or drag to paint obstacles'
		},
		{ id: 'inspect', label: 'Inspect', key: '4', hint: 'Tap an individual to sample its state' }
	];
	let toolHint = $derived(
		tool === 'obstacle'
			? obstacleMode === 'erase'
				? 'Tap or drag to erase nearby obstacles'
				: obstacleShape === 'ring'
					? `Tap to stamp a closed ring of ${scene.world.kind === 'surface' ? 'disks' : 'spheres'}`
					: 'Tap or drag to paint obstacles'
			: tools.find((item) => item.id === tool)?.hint
	);
	let planeLabel = $derived(
		scene.forces.workPlane.normal[1] === 1
			? 'XZ'
			: scene.forces.workPlane.normal[2] === 1
				? 'XY'
				: 'YZ'
	);
	function notify(message: string, action?: string, run?: () => void) {
		toast = { message, action, run };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), action ? 12000 : 6000);
	}
	function snapshot(): SceneDefinition {
		const next = structuredClone(scene);
		if (engine) next.camera = engine.getCamera();
		return next;
	}
	function remember(group = false) {
		if (editSnapshot) {
			if (!editRecorded) {
				undoStack = [...undoStack.slice(-39), editSnapshot];
				editRecorded = true;
			}
			return;
		}
		const now = performance.now();
		if (!group || now - lastChange > 350 || !undoStack.length)
			undoStack = [...undoStack.slice(-39), snapshot()];
		lastChange = now;
	}
	function beginEdit() {
		if (editSnapshot) return;
		editSnapshot = snapshot();
		editRecorded = false;
	}
	function finishEdit() {
		if (!editSnapshot) return;
		editSnapshot = null;
		editRecorded = false;
		lastChange = 0;
	}
	function patch(next: SceneDefinition, reset = false) {
		const checked = validateScene(next);
		if (!checked.ok) {
			notify(checked.issues[0]?.message ?? 'This change is outside the supported range.');
			return;
		}
		remember(true);
		const cameraChanged = JSON.stringify(next.camera) !== JSON.stringify(scene.camera);
		const worldChanged = JSON.stringify(next.world) !== JSON.stringify(scene.world);
		scene = checked.scene;
		syncSurfaceBrush();
		if (reset) {
			clearInspection();
			stats = null;
			engine?.reset(scene);
		} else engine?.updateScene(scene);
		if (cameraChanged) {
			engine?.setCamera(scene.camera);
		}
		if (reset && worldChanged && engine) {
			engine.fitCamera();
			scene = { ...scene, camera: engine.getCamera() };
		}
	}
	function syncSurfaceBrush() {
		if (scene.world.kind !== 'surface') return;
		if (obstacleShape === 'box') obstacleShape = 'sphere';
		obstacleSize = Math.min(
			obstacleSize,
			scene.world.shape === 'torus'
				? maxSurfaceObstacleRadius(scene)
				: worldInteractionLimit(scene.world) - 0.01
		);
		ringRadius = Math.min(ringRadius, (worldInteractionLimit(scene.world) * 2) / 3);
	}
	function load(next: SceneDefinition) {
		finishEdit();
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			next = structuredClone(next);
			next.camera.autoRotate = 0;
		}
		const checked = validateScene(next);
		if (!checked.ok) {
			notify(checked.issues[0]?.message ?? 'Unable to load this scene.');
			return;
		}
		remember();
		scene = checked.scene;
		syncSurfaceBrush();
		clearInspection();
		stats = null;
		engine?.reset(scene);
		engine?.setCamera(scene.camera);
		engine?.setPaused(paused);
		setTool('look');
		libraryOpen = false;
		notify(`Loaded ${scene.name}.`, 'Undo', undo);
	}
	function undo() {
		finishEdit();
		const previous = undoStack.at(-1);
		if (!previous) return;
		undoStack = undoStack.slice(0, -1);
		scene = previous;
		syncSurfaceBrush();
		clearInspection();
		stats = null;
		engine?.reset(scene);
		engine?.setCamera(scene.camera);
		engine?.setPaused(paused);
		toast = null;
		lastChange = 0;
	}
	function setTool(next: EngineTool) {
		if (next !== 'look' && window.matchMedia('(max-width: 700px)').matches) labOpen = false;
		tool = next;
		engine?.setTool(next);
	}
	function applyTheme(theme: 'night' | 'day') {
		return () => {
			const previousTheme = document.documentElement.dataset.theme;
			document.documentElement.dataset.theme = theme;
			return () => {
				if (document.documentElement.dataset.theme !== theme) return;
				if (previousTheme === undefined) delete document.documentElement.dataset.theme;
				else document.documentElement.dataset.theme = previousTheme;
			};
		};
	}
	function toggleTheme() {
		const next = snapshot();
		next.visual.theme = scene.visual.theme === 'day' ? 'night' : 'day';
		patch(next);
		try {
			localStorage.setItem('swarm3d-theme', next.visual.theme);
		} catch {
			/* The mode still works without storage. */
		}
	}
	function togglePause() {
		paused = !paused;
		engine?.setPaused(paused);
	}
	function reset() {
		clearInspection();
		stats = null;
		engine?.reset(scene);
		engine?.setPaused(paused);
		notify('Restarted from the same seed.');
	}
	function step() {
		if (!paused) return;
		engine?.step();
	}
	function resetCamera() {
		engine?.setCamera(scene.camera);
	}
	function fitCamera() {
		engine?.fitCamera();
	}
	function clearInspection() {
		inspection = null;
		inspectionHistory = [];
		engine?.clearSelection();
	}
	function placeObstacle(position: Vec3, normal: Vec3 | null, drag = false) {
		const next = snapshot();
		if (next.world.kind === 'surface') {
			const maximum =
				next.world.shape === 'torus' && obstacleMode === 'place'
					? maxSurfaceObstacleRadius(next)
					: worldInteractionLimit(next.world) - 0.01;
			if (maximum < 0.001 && obstacleMode === 'place') {
				notify('Reduce body size or local ranges to leave room for an obstacle brush.');
				return;
			}
			obstacleSize = Math.min(obstacleSize, maximum);
		}
		if (drag && obstacleShape === 'ring' && obstacleMode === 'place') return;
		if (obstacleShape === 'box' && next.world.kind === 'surface') {
			notify('Surface obstacles use disks. Choose Disk or Ring.');
			return;
		}
		if (obstacleMode === 'erase') {
			const count = next.obstacles.length;
			next.obstacles = next.obstacles.filter(
				(item) =>
					worldDistance(next.world, item.center, position) >
					obstacleSize + (item.shape === 'sphere' ? item.radius : Math.max(...item.halfExtents))
			);
			if (count === next.obstacles.length) {
				notify('No obstacles within the erase brush.');
				return;
			}
			patch(next);
			return;
		}
		const needed = obstacleShape === 'ring' ? 16 : 1;
		if (
			drag &&
			next.obstacles.some(
				(item) => worldDistance(next.world, item.center, position) < obstacleSize * 0.65
			)
		)
			return;
		if (next.obstacles.length + needed > 32) {
			notify(`The scene supports 32 obstacles. This brush needs ${needed} free slots.`);
			return;
		}
		if (obstacleShape === 'sphere')
			next.obstacles.push({
				id: crypto.randomUUID(),
				shape: 'sphere',
				center: position,
				radius: obstacleSize
			});
		else if (obstacleShape === 'box')
			next.obstacles.push({
				id: crypto.randomUUID(),
				shape: 'box',
				center: position,
				halfExtents: [obstacleSize, obstacleSize, obstacleSize]
			});
		else {
			const n = normal ?? next.forces.workPlane.normal;
			const reference: Vec3 = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
			const raw = [
				n[1] * reference[2] - n[2] * reference[1],
				n[2] * reference[0] - n[0] * reference[2],
				n[0] * reference[1] - n[1] * reference[0]
			];
			const length = Math.hypot(...raw);
			const a = raw.map((v) => v / length);
			const b = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
			const arc = Math.min(ringRadius, (worldInteractionLimit(next.world) * 2) / 3);
			const footprint =
				next.world.kind === 'surface' && next.world.shape === 'sphere'
					? next.world.radius * Math.sin(arc / next.world.radius)
					: arc;
			for (let i = 0; i < 16; i++) {
				const angle = (i / 16) * Math.PI * 2;
				const tangent = a.map((v, index) => v * Math.cos(angle) + b[index] * Math.sin(angle));
				const displacement: Vec3 = [tangent[0] * arc, tangent[1] * arc, tangent[2] * arc];
				const center =
					next.world.kind === 'surface' && next.world.shape === 'torus'
						? torusPoint(
								next.world,
								torusLocalPoint(
									next.world,
									torusChart(next.world, position),
									torusComponents(torusChart(next.world, position), displacement)
								)
							)
						: next.world.kind === 'surface'
							? worldExp(next.world, position, displacement)
							: ([
									position[0] + displacement[0],
									position[1] + displacement[1],
									position[2] + displacement[2]
								] as const);
				next.obstacles.push({
					id: crypto.randomUUID(),
					shape: 'sphere',
					center,
					radius: Math.min(
						next.world.kind === 'surface' && next.world.shape === 'torus'
							? maxSurfaceObstacleRadius(next)
							: Infinity,
						Math.max(0.15, footprint * Math.sin(Math.PI / 16) * 1.08)
					)
				});
			}
		}
		patch(next);
	}
	function cameraKey(id: string) {
		if (!engine) return;
		const camera = engine.getCamera();
		if (id === 'camera-left') camera.yaw -= 0.08;
		if (id === 'camera-right') camera.yaw += 0.08;
		if (id === 'camera-up') camera.pitch = Math.min(Math.PI / 2 - 0.01, camera.pitch + 0.08);
		if (id === 'camera-down') camera.pitch = Math.max(-Math.PI / 2 + 0.01, camera.pitch - 0.08);
		if (id === 'zoom-in') camera.distance = Math.max(1, camera.distance * 0.92);
		if (id === 'zoom-out') camera.distance = Math.min(100000, camera.distance / 0.92);
		engine.setCamera(camera);
	}
	function boot(element: HTMLCanvasElement) {
		canvas = element;
		let ended = false;
		let failed = false;
		let mountedEngine: Engine | null = null;
		const controller = new AbortController();
		status = 'loading';
		error = '';
		const initial = scene;
		void createEngine(
			element,
			initial,
			{
				onStats: (value) => {
					if (!ended && !failed) stats = value;
				},
				onInspect: (value) => {
					if (!ended && !failed) {
						inspection = value;
						inspectionHistory = appendInspectionHistory(inspectionHistory, value);
					}
				},
				onReady: () => {
					if (!ended && !failed) status = 'ready';
				},
				onError: (value) => {
					if (!ended) {
						failed = true;
						status = 'error';
						error = value.message;
						stopRecording();
						mountedEngine?.dispose();
						if (engine === mountedEngine) engine = null;
						stats = null;
						inspection = null;
						inspectionHistory = [];
					}
				},
				onObstacle: (position, normal, ...gesture: [boolean?]) => {
					if (ended || failed) return;
					placeObstacle(position, normal, gesture[0]);
				}
			},
			controller.signal
		)
			.then((value) => {
				if (ended || controller.signal.aborted || failed) value.dispose();
				else {
					mountedEngine = value;
					engine = value;
					if (scene !== initial) {
						engine.reset(scene);
						engine.setCamera(scene.camera);
					}
					engine.setTool(tool);
					engine.setPaused(paused);
					status = 'ready';
				}
			})
			.catch((value: unknown) => {
				if (!ended && !controller.signal.aborted) {
					failed = true;
					mountedEngine?.dispose();
					if (engine === mountedEngine) engine = null;
					status = 'error';
					error = value instanceof Error ? value.message : String(value);
				}
			});
		return () => {
			ended = true;
			controller.abort();
			mountedEngine?.dispose();
			if (engine === mountedEngine) engine = null;
			if (canvas === element) {
				stopRecording();
				canvas = null;
				stats = null;
				inspection = null;
				inspectionHistory = [];
			}
		};
	}
	function attachCanvas(element: HTMLCanvasElement) {
		return untrack(() => boot(element));
	}
	function download(blob: Blob, name: string) {
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = name;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	function filename(extension: string) {
		return `swarm-${
			scene.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '') || 'scene'
		}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
	}
	async function capture() {
		if (!engine || status !== 'ready') return;
		const active = engine;
		const name = filename('png');
		try {
			const blob = await active.screenshot();
			if (!disposed && engine === active) keepCapture(blob, 'png', name);
		} catch (value) {
			if (!disposed && engine === active)
				notify(`Capture failed: ${value instanceof Error ? value.message : String(value)}`);
		}
	}
	function keepCapture(blob: Blob, extension: string, name = filename(extension)) {
		const file = new File([blob], name, { type: blob.type });
		download(file, file.name);
		notify(
			`${extension === 'png' ? 'PNG' : 'Video'} captured from the canvas.`,
			'Share capture',
			() => void shareCapture(file)
		);
	}
	async function shareCapture(file: File) {
		if (navigator.share && navigator.canShare?.({ files: [file] })) {
			try {
				await navigator.share({ files: [file], title: file.name });
				notify('Capture shared.');
			} catch (value) {
				if (value instanceof Error && value.name === 'AbortError') return;
				notify(
					`Unable to share capture: ${value instanceof Error ? value.message : String(value)}`,
					'Save again',
					() => download(file, file.name)
				);
			}
		} else {
			download(file, file.name);
			notify('Native file sharing is unavailable. Saved another copy.');
		}
	}
	function stopRecording() {
		if (recorder?.state === 'recording') {
			recordingPending = true;
			recorder.stop();
		}
		clearInterval(recordingTimer);
		recording = false;
	}
	function record() {
		if (recordingPending) return;
		if (recording) {
			stopRecording();
			return;
		}
		if (!canvas || status !== 'ready') return;
		if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
			notify('Video recording is unavailable in this browser. PNG capture is available.');
			return;
		}
		try {
			const mime = [
				'video/mp4;codecs=avc1.42E01E',
				'video/mp4',
				'video/webm;codecs=vp9',
				'video/webm;codecs=vp8',
				'video/webm'
			].find((type) => MediaRecorder.isTypeSupported(type));
			if (!mime) {
				notify('This browser has no supported video encoder.');
				return;
			}
			const stream = canvas.captureStream(60);
			recordingStream = stream;
			const session = new MediaRecorder(stream, {
				mimeType: mime,
				videoBitsPerSecond: 12_000_000
			});
			recorder = session;
			let sessionFailed = false;
			let sessionTimer: ReturnType<typeof setInterval> | undefined;
			const extension = mime.includes('mp4') ? 'mp4' : 'webm';
			const outputName = filename(extension);
			const chunks: Blob[] = [];
			session.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			session.onstop = () => {
				stream.getTracks().forEach((track) => track.stop());
				clearInterval(sessionTimer);
				if (recorder === session) {
					recordingStream = null;
					recorder = null;
					recording = false;
					recordingPending = false;
				}
				if (!disposed && !sessionFailed && chunks.length) {
					keepCapture(new Blob(chunks, { type: mime }), extension, outputName);
				}
			};
			session.onerror = () => {
				sessionFailed = true;
				if (recorder === session) stopRecording();
				stream.getTracks().forEach((track) => track.stop());
				notify('The browser could not finish the video recording.');
			};
			session.start(1000);
			recording = true;
			recordingSeconds = 0;
			sessionTimer = setInterval(() => recordingSeconds++, 1000);
			recordingTimer = sessionTimer;
		} catch (value) {
			recordingStream?.getTracks().forEach((track) => track.stop());
			recordingStream = null;
			recorder = null;
			recording = false;
			recordingPending = false;
			notify(`Recording failed: ${value instanceof Error ? value.message : String(value)}`);
		}
	}
	async function thumbnail() {
		if (!engine || status !== 'ready') return undefined;
		try {
			const bitmap = await createImageBitmap(await engine.screenshot());
			const image = document.createElement('canvas');
			image.width = 360;
			image.height = 202;
			image.getContext('2d')?.drawImage(bitmap, 0, 0, image.width, image.height);
			bitmap.close();
			return image.toDataURL('image/jpeg', 0.65);
		} catch {
			return undefined;
		}
	}
	async function refreshSaved() {
		saved = await sceneRepository.list();
	}
	async function save(name = scene.name, copy = false): Promise<boolean> {
		if (saving) return false;
		saving = true;
		const source = scene;
		try {
			const next = snapshot();
			next.name = name.trim() || 'Untitled scene';
			if (copy || !saved.some((item) => item.id === next.id)) next.id = crypto.randomUUID();
			await sceneRepository.put(next, await thumbnail());
			if (disposed) return false;
			if (scene === source) scene = next;
			await refreshSaved();
			notify(`Saved ${next.name} on this device.`);
			return true;
		} catch (value) {
			notify(`Unable to save: ${value instanceof Error ? value.message : String(value)}`);
			return false;
		} finally {
			saving = false;
		}
	}
	async function remove(record: SavedScene) {
		try {
			const removed = await sceneRepository.remove(record.id);
			await refreshSaved();
			if (removed)
				notify(`Deleted ${record.name}.`, 'Undo', () => {
					void sceneRepository
						.restore(removed)
						.then(refreshSaved)
						.then(() => (toast = null))
						.catch((value: Error) => notify(value.message));
				});
		} catch (value) {
			notify(`Unable to delete: ${value instanceof Error ? value.message : String(value)}`);
		}
	}
	async function rename(record: SavedScene, name: string): Promise<boolean> {
		if (!name.trim()) return false;
		try {
			const next = structuredClone(record.scene);
			next.name = name.trim();
			await sceneRepository.put(next, record.thumbnail);
			if (scene.id === next.id) scene = { ...scene, name: next.name };
			await refreshSaved();
			return true;
		} catch (value) {
			notify(`Unable to rename: ${value instanceof Error ? value.message : String(value)}`);
			return false;
		}
	}
	function exportCurrent() {
		download(new Blob([exportScene(snapshot())], { type: 'application/json' }), filename('json'));
		notify('Scene settings exported.');
	}
	function importCurrent(text: string) {
		try {
			const next = importScene(text);
			if (saved.some((item) => item.id === next.id)) next.id = crypto.randomUUID();
			load(next);
			notify(`Imported ${next.name}. Save it to keep it on this device.`);
		} catch (value) {
			notify(`Unable to import: ${value instanceof Error ? value.message : String(value)}`);
		}
	}
	async function share() {
		try {
			const url = sceneShareUrl(snapshot(), location.href.split('#')[0]);
			if (url.length > 24000) {
				notify(
					'This scene is too large for a reliable link. Export it as a JSON file.',
					'Export',
					exportCurrent
				);
				return;
			}
			shareUrl = url;
			libraryOpen = false;
		} catch (value) {
			notify(`Unable to share: ${value instanceof Error ? value.message : String(value)}`);
		}
	}
	async function copyShare() {
		try {
			await navigator.clipboard.writeText(shareUrl);
			notify('Scene link copied.');
			shareUrl = '';
		} catch {
			notify('Select the link and copy it manually.');
		}
	}
	function discover() {
		const values = new Uint32Array(1);
		crypto.getRandomValues(values);
		load(discoverScene(values[0], snapshot()));
	}
	function openHelp(guided = false) {
		libraryOpen = false;
		tour = guided;
		helpOpen = true;
		welcome = false;
		try {
			localStorage.setItem('swarm3d-welcomed', '1');
		} catch {
			/* A private browser can still use the guide. */
		}
	}
	function closeStageActions() {
		if (!stageActions) return;
		stageActions.open = false;
		stageActions.querySelector('summary')?.focus({ preventScroll: true });
	}
	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && recording) {
			event.preventDefault();
			stopRecording();
			return;
		}
		if (event.key === 'Escape' && stageActions?.open) {
			closeStageActions();
			event.preventDefault();
			return;
		}
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || modalOpen)
			return;
		if (
			event.target instanceof HTMLElement &&
			event.target.closest(
				'input,textarea,select,button,summary,[role="combobox"],[role="listbox"],[role="option"],[contenteditable="true"]'
			)
		)
			return;
		const shortcut = SHORTCUTS.find((item) =>
			item.keys.some((key) => key === event.key.toLowerCase())
		);
		if (!shortcut) return;
		event.preventDefault();
		switch (shortcut.id) {
			case 'pause':
				togglePause();
				break;
			case 'step':
				step();
				break;
			case 'reset':
				reset();
				break;
			case 'look':
			case 'force':
			case 'obstacle':
			case 'inspect':
				setTool(shortcut.id);
				break;
			case 'camera':
				resetCamera();
				break;
			case 'fit':
				fitCamera();
				break;
			case 'camera-left':
			case 'camera-right':
			case 'camera-up':
			case 'camera-down':
			case 'zoom-in':
			case 'zoom-out':
				cameraKey(shortcut.id);
				break;
			case 'laboratory':
				labOpen = !labOpen;
				break;
			case 'save':
				void save();
				break;
			case 'capture':
				void capture();
				break;
			case 'help':
				openHelp();
				break;
			case 'escape':
				setTool('look');
				clearInspection();
				break;
		}
	}
	function readSharedHash() {
		if (!location.hash.startsWith('#scene=')) return;
		try {
			load(decodeSceneShare(location.hash));
			welcome = false;
		} catch (value) {
			notify(
				`Shared scene could not be loaded: ${value instanceof Error ? value.message : String(value)}`
			);
		}
	}
	onMount(() => {
		disposed = false;
		void refreshSaved().catch(() =>
			notify('Local scene storage is unavailable. You can still export settings.')
		);
		try {
			welcome = !localStorage.getItem('swarm3d-welcomed');
			if (!location.hash.startsWith('#scene=') && localStorage.getItem('swarm3d-theme') === 'day') {
				scene = { ...scene, visual: { ...scene.visual, theme: 'day' } };
				engine?.updateScene(scene);
			}
		} catch {
			welcome = true;
		}
		readSharedHash();
		return () => {
			disposed = true;
			stopRecording();
			recordingStream?.getTracks().forEach((track) => track.stop());
			clearTimeout(toastTimer);
		};
	});
</script>

<svelte:head
	><title>Swarm 3D</title><meta
		name="description"
		content="Explore collective motion in three dimensions. A WebGPU laboratory for flocking, interactions, and emergence."
	/><meta name="theme-color" content="#080e12" /></svelte:head
>
<svelte:window
	onkeydown={keydown}
	onhashchange={readSharedHash}
	onpointerdown={(event) => {
		if (
			stageActions?.open &&
			event.target instanceof Node &&
			!stageActions.contains(event.target)
		) {
			stageActions.open = false;
		}
	}}
/>

<main
	{@attach applyTheme(scene.visual.theme ?? 'night')}
	class="swarm-app"
	class:lab-hidden={!labOpen}
	style="--scene-background:{stageBackground(scene.visual)}"
>
	{#key retry}<canvas
			{@attach attachCanvas}
			class="simulation-canvas"
			aria-label="Interactive three-dimensional swarm. Use the toolbar to choose Look, Force, Obstacle, or Inspect."
			tabindex="0"
		></canvas>{/key}
	<div class="stage-vignette" aria-hidden="true"></div>

	{#if labOpen}<Laboratory
			{scene}
			brandActive={!paused}
			onchange={patch}
			oneditstart={beginEdit}
			oneditend={finishEdit}
			ontool={setTool}
			bind:section
			onlibrary={() => (libraryOpen = true)}
			onhelp={() => openHelp()}
			onclose={() => (labOpen = false)}
		/>{:else}<button
			class="reopen-lab glass"
			onclick={() => (labOpen = true)}
			aria-label="Show laboratory (L)"
			><SwarmLogo size={25} active={!paused} /><span>Swarm 3D</span></button
		>{/if}
	<div class="stage-caption" aria-hidden="true">
		<SwarmLogo size={34} active={!paused} />
		<div>
			<span class="stage-scene-name">{scene.name}</span><span class="stage-domain-label"
				>{scene.world.kind === 'volume' ? 'In a volume' : `On a ${scene.world.shape}`}</span
			>
		</div>
	</div>
	<div class="stage-controls stage-dock glass" role="toolbar" aria-label="Stage controls">
		<div class="playback-bar" role="group" aria-label="Simulation and capture">
			<button
				class="icon-button play-toggle"
				title="{paused ? 'Resume' : 'Pause'} (Space)"
				aria-label={paused ? 'Resume simulation' : 'Pause simulation'}
				disabled={status !== 'ready'}
				onclick={togglePause}><Icon name={paused ? 'play' : 'pause'} size={17} /></button
			>
			<button
				class="icon-button step-button"
				title="Step (.)"
				aria-label="Advance one fixed simulation step"
				disabled={!paused || status !== 'ready'}
				onclick={step}><Icon name="step" size={15} /></button
			>
			<label class="playback-speed" title="Simulation speed. Species movement is set in Flocking.">
				<span class="speed-label">Speed</span>
				<input
					type="range"
					aria-label="Simulation speed"
					min="0.01"
					max={Math.max(3, scene.dynamics.timeScale)}
					step="0.01"
					value={scene.dynamics.timeScale}
					oninput={(event) => {
						const next = structuredClone(scene);
						next.dynamics.timeScale = Number(event.currentTarget.value);
						patch(next);
					}}
				/>
				<output>{scene.dynamics.timeScale.toFixed(2)}×</output>
			</label>
		</div>
		<span class="toolbar-separator"></span>
		<div class="tool-bar" role="group" aria-label="Canvas interaction tools">
			{#each tools as item (item.id)}<button
					class="tool-{item.id}"
					class:active={tool === item.id}
					aria-label={item.label}
					aria-pressed={tool === item.id}
					title="{item.label} ({item.key})"
					onclick={() => setTool(item.id)}
					><Icon name={item.id} size={16} /><span>{item.label}</span></button
				>{/each}
		</div>
		<span class="toolbar-separator"></span>
		<div class="dock-actions">
			<button
				class="icon-button secondary-action"
				title="Restart same seed (R)"
				aria-label="Restart simulation from the same seed"
				disabled={status !== 'ready'}
				onclick={reset}><Icon name="reset" size={16} /></button
			>
			<button
				class="icon-button secondary-action"
				title="Fit world (F)"
				aria-label="Fit camera to world"
				disabled={status !== 'ready'}
				onclick={fitCamera}><Icon name="fit" size={16} /></button
			>
			<button
				class="icon-button secondary-action"
				title="Undo settings change"
				aria-label="Undo settings change"
				disabled={!undoStack.length}
				onclick={undo}><Icon name="back" size={15} /></button
			>
			<button
				class="icon-button theme-toggle"
				aria-label={scene.visual.theme === 'day' ? 'Switch to night mode' : 'Switch to day mode'}
				title={scene.visual.theme === 'day' ? 'Night mode' : 'Day mode'}
				aria-pressed={scene.visual.theme === 'day'}
				onclick={toggleTheme}
			>
				<svg
					viewBox="0 0 24 24"
					width="17"
					height="17"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					aria-hidden="true"
				>
					{#if scene.visual.theme === 'day'}<path
							d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"
						/>{:else}<circle cx="12" cy="12" r="3.5" /><path
							d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"
						/>{/if}
				</svg>
			</button>
			<button
				class="icon-button capture-action"
				title="Capture PNG (P)"
				aria-label="Capture canvas as PNG"
				disabled={status !== 'ready'}
				onclick={() => void capture()}><Icon name="camera" size={17} /></button
			>
			<button
				class="icon-button record-action"
				class:recording
				title={recordingPending
					? 'Finishing video capture'
					: recording
						? 'Stop video recording'
						: 'Record video'}
				aria-label={recordingPending
					? 'Finishing video capture'
					: recording
						? 'Stop video recording'
						: 'Record canvas video'}
				disabled={status !== 'ready' || recordingPending}
				onclick={record}><Icon name={recording ? 'stop' : 'video'} size={17} /></button
			>
			<details
				class="dock-menu"
				{@attach (node) => {
					stageActions = node;
					return () => {
						stageActions = undefined;
					};
				}}
			>
				<summary aria-label="More stage actions" title="More actions"
					><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
						><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle
							cx="12"
							cy="12"
							r="1.4"
							fill="currentColor"
						/><circle cx="19" cy="12" r="1.4" fill="currentColor" /></svg
					></summary
				>
				<div class="dock-menu-panel glass">
					<button
						class="mobile-action"
						disabled={status !== 'ready'}
						onclick={() => {
							reset();
							closeStageActions();
						}}><Icon name="reset" size={15} />Restart simulation<kbd>R</kbd></button
					>
					<button
						class="mobile-action"
						disabled={status !== 'ready'}
						onclick={() => {
							fitCamera();
							closeStageActions();
						}}><Icon name="fit" size={15} />Fit world<kbd>F</kbd></button
					>
					<button
						class="mobile-action"
						disabled={!undoStack.length}
						onclick={() => {
							undo();
							closeStageActions();
						}}><Icon name="back" size={15} />Undo settings</button
					>
					<button
						onclick={() => {
							resetCamera();
							closeStageActions();
						}}
						disabled={status !== 'ready'}
						><Icon name="look" size={15} />Reset framing<kbd>C</kbd></button
					>
					<button
						onclick={() => {
							void save();
							closeStageActions();
						}}><Icon name="save" size={15} />Save scene<kbd>S</kbd></button
					>
					<button
						onclick={() => {
							libraryOpen = true;
							closeStageActions();
						}}><Icon name="grid" size={15} />Browse scenes</button
					>
					<button
						onclick={() => {
							discover();
							closeStageActions();
						}}><Icon name="dice" size={15} />Discover</button
					>
					<button
						onclick={() => {
							openHelp();
							closeStageActions();
						}}><Icon name="help" size={15} />Field guide<kbd>?</kbd></button
					>
				</div>
			</details>
		</div>
	</div>
	{#if recording}<div class="recording-indicator glass">
			<span></span>REC {Math.floor(recordingSeconds / 60)
				.toString()
				.padStart(2, '0')}:{(recordingSeconds % 60).toString().padStart(2, '0')}<button
				onclick={stopRecording}>Stop</button
			>
		</div>{/if}
	{#if tool === 'force' && !inspection}
		<aside class="force-context glass" aria-label="Pointer force context">
			<div class="force-context-line">
				<Icon name="force" size={16} />
				<h3>Pointer field</h3>
				<button
					class="field-state"
					class:enabled={scene.forces.enabled}
					onclick={() => {
						const next = structuredClone(scene);
						next.forces.enabled = !next.forces.enabled;
						patch(next);
					}}
					aria-pressed={scene.forces.enabled}>{scene.forces.enabled ? 'On' : 'Enable'}</button
				>
			</div>
			<div class="context-values">
				<span
					>{scene.forces.shape === 'ring' ? 'Ring' : 'Disk'}<b>{scene.forces.radius.toFixed(1)} u</b
					></span
				><span>Power<b>{scene.forces.power.toFixed(1)}</b></span>
			</div>
			<div class="force-context-bottom">
				<span
					>{scene.world.kind === 'surface'
						? scene.world.shape
						: `${planeLabel} plane · ${(scene.forces.workPlane.offset + scene.forces.depth).toFixed(1)} u`}</span
				>
				<button
					class="text-button"
					onclick={() => {
						section = 'forces';
						labOpen = true;
					}}>Settings<Icon name="chevron" size={12} /></button
				>
			</div>
			{#if !scene.forces.enabled}<p class="force-off-note">
					Enable the field to influence agents.
				</p>{/if}
		</aside>
	{/if}
	{#if tool === 'obstacle'}
		<aside class="obstacle-brush glass" aria-label="Obstacle brush">
			<div class="subsection-heading">
				<h3>Obstacle brush</h3>
				<span>{scene.obstacles.length}/32</span>
			</div>
			<div class="segmented">
				<button
					class:active={obstacleMode === 'place'}
					aria-pressed={obstacleMode === 'place'}
					onclick={() => (obstacleMode = 'place')}>Place</button
				><button
					class:active={obstacleMode === 'erase'}
					aria-pressed={obstacleMode === 'erase'}
					onclick={() => (obstacleMode = 'erase')}>Erase</button
				>
			</div>
			{#if obstacleMode === 'place'}<div class="field">
					<span>Primitive</span><Select
						label="Primitive"
						value={obstacleShape}
						options={[
							{
								value: 'sphere',
								label: scene.world.kind === 'surface' ? 'Disk' : 'Sphere',
								icon: 'sphere'
							},
							...(scene.world.kind === 'volume'
								? [{ value: 'box', label: 'Box', icon: 'box' }]
								: []),
							{
								value: 'ring',
								label: 'Ring',
								description: `Stamp 16 ${scene.world.kind === 'surface' ? 'disks' : 'spheres'}.`,
								icon: 'torus'
							}
						]}
						onchange={(value) => (obstacleShape = value as typeof obstacleShape)}
					/>
				</div>{/if}
			{#if obstacleMode === 'place' && obstacleShape === 'ring'}<Parameter
					label="Ring radius"
					value={ringRadius}
					min={Math.min(0.5, ringLimit / 2)}
					max={ringLimit}
					step={scene.world.kind === 'surface' && scene.world.shape === 'torus' ? 0.01 : 0.1}
					disabled={scene.world.kind === 'surface' &&
						scene.world.shape === 'torus' &&
						surfaceBrushLimit < 0.001}
					unit="u"
					onchange={(value) => (ringRadius = value)}
				/>
				<p class="fine-print">
					A closed ring follows the volume work plane, or an intrinsic circle along the surface.
					Surface circles are clipped at reflecting edges; torus rings follow the same local
					midpoint distance used by forces.
				</p>{:else}<Parameter
					label={obstacleMode === 'erase'
						? 'Erase radius'
						: obstacleShape === 'box'
							? 'Box half-size'
							: scene.world.kind === 'surface'
								? 'Disk radius'
								: 'Sphere radius'}
					value={obstacleSize}
					min={Math.min(0.25, obstacleLimit / 2)}
					max={Math.max(0.001, obstacleLimit)}
					step={scene.world.kind === 'surface' && scene.world.shape === 'torus'
						? Math.min(0.01, obstacleLimit / 10)
						: 0.25}
					digits={scene.world.kind === 'surface' && scene.world.shape === 'torus' ? 3 : 1}
					disabled={obstacleMode === 'place' && obstacleLimit < 0.001}
					unit="u"
					onchange={(value) => (obstacleSize = value)}
				/>{/if}
			{#if scene.world.kind === 'surface' && scene.world.shape === 'torus' && obstacleMode === 'place'}<p
					class="fine-print"
				>
					Each disk is limited to {surfaceBrushLimit.toLocaleString(undefined, {
						maximumFractionDigits: 3
					})} u, including body and avoidance margins within 0.3r.
				</p>{/if}
			<p class="group-note">
				{obstacleMode === 'erase'
					? 'Tap or drag to erase within the brush. Changes can be undone.'
					: obstacleShape === 'ring'
						? 'Tap to stamp a ring. In a volume, placement follows the force work plane.'
						: 'Tap or drag to paint. In a volume, placement follows the force work plane.'}
			</p>
		</aside>
	{/if}
	{#if inspection}{#key `${inspection.speciesKey}:${inspection.id}`}<Inspector
				sample={inspection}
				history={inspectionHistory}
				{paused}
				{scene}
				onclose={() => {
					clearInspection();
					setTool('look');
				}}
			/>{/key}{/if}
	{#if status === 'loading'}<div class="engine-state glass" role="status">
			<SwarmLogo size={64} />
			<h2>Preparing the world</h2>
			<p>Starting the GPU simulation.</p>
		</div>{:else if status === 'error'}<div class="engine-state glass" role="alert">
			<Icon name="warning" size={28} />
			<h2>The GPU world is unavailable</h2>
			<p>{error}</p>
			<p class="small muted">
				Swarm requires a browser with WebGPU and a supported GPU. Try an up-to-date Chrome, Edge, or
				Safari.
			</p>
			<button class="primary-button" onclick={() => retry++}
				>Try again<Icon name="reset" size={15} /></button
			>
		</div>{/if}
	{#if welcome && status === 'ready' && !modalOpen}<div class="welcome-card glass">
			<button class="text-button" onclick={() => openHelp(true)}
				><Icon name="help" size={13} />New to Swarm? Take a tour</button
			>
			<button
				class="icon-button welcome-close"
				aria-label="Dismiss welcome"
				onclick={() => {
					welcome = false;
					try {
						localStorage.setItem('swarm3d-welcomed', '1');
					} catch {
						/* Optional preference. */
					}
				}}><Icon name="close" size={13} /></button
			>
		</div>{/if}
	<div class="canvas-hint">
		<Icon name={tool} size={12} />{toolHint}<span>Two fingers pan + pinch</span>
	</div>
	<footer class="status-strip">
		<div>
			<span
				class="status-dot"
				class:paused
				class:behind-target={behindTarget}
				class:initializing={status === 'loading'}
				class:error={status === 'error'}
			></span><span
				title={behindTarget
					? 'The achieved simulation rate is below the requested time scale.'
					: scene.dynamics.timeScale < 1
						? 'The requested time scale deliberately slows simulated time.'
						: undefined}>{runLabel}</span
			><b
				title={stats
					? 'GPU population from the latest status sample.'
					: 'Configured population; awaiting a GPU status sample.'}
				>{(stats?.population ?? renderPopulation).toLocaleString()}</b
			><span>agents</span>
		</div>
		<div class="status-measures">
			<span data-tick={stats?.tick ?? 0} title="Fixed simulation tick {stats?.tick ?? 0}"
				><b>{stats ? stats.simulationTime.toFixed(paused ? 3 : 1) : '—'}</b> s</span
			><span
				title="Frames submitted for display each second; paused scenes render when the view changes."
				><b>{stats ? stats.fps.toFixed(0) : '—'}</b> render fps</span
			><span
				data-time-scale={scene.dynamics.timeScale}
				title="Achieved simulation seconds per wall second. Requested time scale: {scene.dynamics.timeScale.toFixed(
					2
				)}×. Rendering throughput and the step budget can reduce the achieved rate."
				><b>{stats ? stats.realTimeFactor.toFixed(2) : '—'}</b><span
					class="playback-achieved"
					class:behind-target={behindTarget}>× achieved</span
				>
				<small>/ {scene.dynamics.timeScale.toFixed(2)} target</small></span
			><span><b>{stats ? (stats.trailBytes / 1048576).toFixed(1) : '—'}</b> MB trails</span>
		</div>
		<div class="status-device" title={stats?.adapter ?? 'GPU not initialized'}>
			WebGPU <span>via vgpu</span>
		</div>
	</footer>
	{#if toast && !modalOpen}<Notification {toast} onclose={() => (toast = null)} />{/if}
</main>

{#if libraryOpen}<SceneLibrary
		{scene}
		{saved}
		{saving}
		onload={load}
		onsave={save}
		ondelete={(record) => void remove(record)}
		onrename={rename}
		onexport={exportCurrent}
		onimport={importCurrent}
		onshare={() => void share()}
		ondiscover={discover}
		onclose={() => (libraryOpen = false)}
		{notification}
	/>{/if}
{#if helpOpen}<HelpDialog
		{tour}
		onclose={() => (helpOpen = false)}
		{notification}
		onsection={(next) => {
			section = next;
			labOpen = true;
		}}
	/>{/if}
{#if shareUrl}<Modal
		title="Share this world"
		subtitle="A link to the settings, seed, obstacles, and camera."
		onclose={() => (shareUrl = '')}
		notice={notification}
		><label class="field"
			>Scene link<textarea
				readonly
				value={shareUrl}
				rows="4"
				onclick={(event) => event.currentTarget.select()}></textarea></label
		>
		<p class="fine-print">
			Opening the link starts a fresh simulation. Local saved scenes and captured images are kept on
			this device.
		</p>
		<div class="modal-actions">
			<button class="text-button" onclick={exportCurrent}
				><Icon name="export" size={14} />Export JSON</button
			><button class="primary-button" onclick={() => void copyShare()}
				><Icon name="share" size={15} />Copy link</button
			>
		</div></Modal
	>{/if}

{#snippet notification()}{#if toast}<Notification
			{toast}
			inline
			onclose={() => (toast = null)}
		/>{/if}{/snippet}
