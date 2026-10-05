export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];
export type Hsl = readonly [number, number, number];
export type TopologyShape = 'mobius' | 'klein' | 'projective' | 'genus2';

/** Distances are world units, velocities units/second, accelerations units/second². */
export type WorldDefinition =
	| { kind: 'volume'; shape: 'box'; halfExtents: Vec3; boundaries: 'reflect' | 'periodic' }
	| { kind: 'volume'; shape: 'sphere'; radius: number }
	| { kind: 'volume'; shape: 'cylinder'; radius: number; halfHeight: number }
	| { kind: 'volume'; shape: 'torus'; majorRadius: number; tubeRadius: number }
	| { kind: 'surface'; shape: 'sphere'; radius: number }
	| { kind: 'surface'; shape: 'plane'; halfExtents: Vec2; boundaries: 'reflect' | 'periodic' }
	| { kind: 'surface'; shape: 'cylinder'; radius: number; halfHeight: number }
	/** Induced metric; local interactions use the audited midpoint approximation. */
	| { kind: 'surface'; shape: 'torus'; majorRadius: number; tubeRadius: number }
	/** Triangulated visible geometry, with retained sheet identity and local unfolding. */
	| { kind: 'surface'; shape: TopologyShape; radius: number };

export const BEHAVIORS = [
	'ignore',
	'flee',
	'chase',
	'cohere',
	'align',
	'orbit',
	'follow',
	'guard',
	'disperse',
	'mob',
	'mirror',
	'spiral'
] as const;
export type Behavior = (typeof BEHAVIORS)[number];
export type BodyShape = 'arrow' | 'cone' | 'diamond' | 'sphere' | 'ribbon';
export type PaletteId = 'chrome' | 'ocean' | 'bands' | 'rainbow' | 'mono';
export type MetricId =
	| 'speed'
	| 'turn-rate'
	| 'acceleration'
	| 'neighbor-count'
	| 'density'
	| 'anisotropy'
	| 'polarization'
	| 'radial-flow'
	| 'heading-azimuth'
	| 'center-distance'
	| 'center-bearing'
	| 'flow-orbit'
	| 'center-orbit-angle'
	| 'center-radial-speed'
	| 'speed-contrast';
export type ChannelSource = 'constant' | MetricId;
export type CurvePoint = readonly [number, number];
/** Shape-preserving cubic interpolation is monotone within each control-point interval. */
export interface MonotoneCurve {
	points: CurvePoint[];
}
export type CurvePresetId =
	| 'linear'
	| 's-curve'
	| 'boost-low'
	| 'boost-high'
	| 'inverted'
	| 'exp-rise'
	| 'exp-decay'
	| 'bowl'
	| 'bell';
export interface ChannelMap {
	enabled: boolean;
	source: ChannelSource;
	/** Physical or dimensionless range mapping this source onto [0,1]. */
	range: readonly [number, number];
	strength: number;
	curve: MonotoneCurve;
}
export interface SpeciesVisual {
	hsl: Hsl;
	hue: ChannelMap;
	saturation: ChannelMap;
	lightness: ChannelMap;
}
export interface MetricRule {
	id: string;
	metric: MetricId;
	role: 'neighbor' | 'self' | 'difference';
	range: readonly [number, number];
	curve: MonotoneCurve;
	behavior: Behavior;
	strength: number;
	/** null means the source species' perception radius. */
	radius: number | null;
}
export interface SpeciesDefinition {
	key: string;
	name: string;
	population: number;
	body: BodyShape;
	/** Physical collision radius; the visible tip may extend beyond this radius. */
	size: number;
	/** Length is seconds, independent of the display frame rate. */
	trail: { length: number; width: number; opacity: number };
	visual: SpeciesVisual;
	alignment: number;
	cohesion: number;
	separation: number;
	perception: number;
	/** Maximum physical speed, in units/second. */
	speed: number;
	/** Active propulsion target in units/second; force limits permit transient slower motion. */
	cruiseSpeed: number;
	force: number;
	rebels: { fraction: number; strength: number; period: number; duration: number };
	cursor: { response: 'attract' | 'repel' | 'ignore'; strength: number; vortex: number };
	metricRules: MetricRule[];
}
export interface DirectedRule {
	id: string;
	from: string;
	/** '*' is a fallback; an explicit rule (including Ignore) takes precedence. */
	to: string;
	behavior: Behavior;
	strength: number;
	/** null means the source species' perception radius. */
	radius: number | null;
}
export type ObstacleDefinition =
	| { id: string; shape: 'sphere'; center: Vec3; radius: number; triangle?: number }
	| { id: string; shape: 'box'; center: Vec3; halfExtents: Vec3; triangle?: number };
export interface CameraDefinition {
	target: Vec3;
	/** Image framing shift in viewport-height NDC units; absent means centered. */
	pan?: readonly [number, number];
	distance: number;
	yaw: number;
	pitch: number;
	autoRotate: number;
}
export interface DynamicsDefinition {
	fixedDt: number;
	maxSubsteps: number;
	timeScale: number;
	noise: number;
	collision: number;
	metricSmoothingSeconds: number;
	orbitAxis: Vec3;
}
export interface ForceFieldSettings {
	enabled: boolean;
	power: number;
	radius: number;
	shape: 'disk' | 'ring';
	depth: number;
	/** Placement plane: dot(point, normal) = offset + depth. */
	workPlane: { normal: Vec3; offset: number };
}
export interface SceneDefinition {
	version: 1;
	id: string;
	name: string;
	description: string;
	seed: number;
	world: WorldDefinition;
	species: SpeciesDefinition[];
	speciesRules: DirectedRule[];
	obstacles: ObstacleDefinition[];
	obstacleSettings: { enabled: boolean; strength: number };
	forces: ForceFieldSettings;
	dynamics: DynamicsDefinition;
	visual: {
		/** Rendering resolution only; does not alter the population, rules or physical clock. */
		quality: 'fast' | 'balanced' | 'sharp';
		palette: PaletteId;
		background: string;
		/** Independent light-stage color; omitted scenes use the porcelain default. */
		dayBackground?: string;
		exposure: number;
		showBoundary: boolean;
		/** Optional, independently enabled spatial reference grid. */
		showGrid?: boolean;
		theme?: 'night' | 'day';
		bloom: boolean;
	};
	camera: CameraDefinition;
}
/** CPU/reference state uses world positions; surface velocities are tangent at position. */
export interface AgentState {
	id: number;
	speciesKey: string;
	position: Vec3;
	velocity: Vec3;
	/** Intrinsic mesh face, retained independently of world position at crossings. */
	triangle?: number;
	/** Transported local orientation on a nonorientable world. */
	orientation?: 1 | -1;
	/** Stable birth ordinal, independent of storage order. */
	birth: number;
}
export interface PopulationState {
	agents: AgentState[];
	nextId: number;
	/** A reset starts a new generation. IDs are stable within a generation. */
	generation: number;
}
export interface NeighborRelation {
	id: number;
	index: number;
	distance: number;
	displacement: Vec3;
	velocity: Vec3;
}
export interface AgentMetrics {
	speed: number;
	turnRate: number;
	acceleration: number;
	neighborCount: number;
	density: number;
	anisotropy: number;
	polarization: number;
	radialFlow: number;
	headingAzimuth: number;
	centerDistance: number;
	centerBearing: number;
	flowOrbit: number;
	centerOrbitAngle: number;
	centerRadialSpeed: number;
	speedContrast: number;
}
export interface MetricDefinition {
	id: MetricId;
	label: string;
	unit: string;
	surfaceUnit?: string;
	description: string;
	range: readonly [number, number];
	circular?: boolean;
	temporal: 'instant' | 'smoothed';
	accuracy: 'exact' | 'local-estimate';
}
export interface SavedScene {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	scene: SceneDefinition;
	thumbnail?: string;
}
export interface SceneRepository {
	list(): Promise<SavedScene[]>;
	get(id: string): Promise<SavedScene | undefined>;
	put(scene: SceneDefinition, thumbnail?: string): Promise<SavedScene>;
	remove(id: string): Promise<SavedScene | undefined>;
	/** Restore the exact removed record; lets a caller implement Undo without losing metadata. */
	restore(record: SavedScene): Promise<void>;
}
