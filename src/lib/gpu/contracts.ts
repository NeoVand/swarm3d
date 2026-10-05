import type { CameraDefinition, SceneDefinition, Vec3 } from '#lib/model';

export type EngineTool = 'look' | 'force' | 'obstacle' | 'inspect';

export interface EngineStats {
	fps: number;
	simulationTime: number;
	tick: number;
	population: number;
	realTimeFactor: number;
	trailBytes: number;
	adapter: string;
}

export interface InspectionSample {
	id: number;
	speciesKey: string;
	position: Vec3;
	velocity: Vec3;
	/** Native sheet identity and transported orientation for triangle surfaces. */
	triangle?: number;
	orientation?: 1 | -1;
	speed: number;
	acceleration: number;
	turnRate: number;
	neighbors: number;
	density: number;
	structure: number;
	simulationTime: number;
	tick: number;
}

export interface EngineCallbacks {
	onStats?: (stats: EngineStats) => void;
	onInspect?: (sample: InspectionSample | null) => void;
	onError?: (error: Error) => void;
	onReady?: () => void;
	onObstacle?: (position: Vec3, normal: Vec3 | null, drag?: boolean, triangle?: number) => void;
}

export interface Engine {
	updateScene(scene: SceneDefinition): void;
	reset(scene?: SceneDefinition): void;
	setPaused(paused: boolean): void;
	step(): void;
	setTool(tool: EngineTool): void;
	selectAt(clientX: number, clientY: number): Promise<void>;
	clearSelection(): void;
	getCamera(): CameraDefinition;
	setCamera(camera: CameraDefinition): void;
	resetCamera(): void;
	fitCamera(): void;
	setAutoRotate(enabled: boolean): void;
	screenshot(): Promise<Blob>;
	dispose(): void;
}
