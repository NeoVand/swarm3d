import {
	BEHAVIORS,
	METRICS,
	sampleCurve,
	worldBounds,
	interactionRadii,
	globalInteractionRadius
} from '#lib/model';
import { isTopologyWorld, topologyMesh, nearestTopologyPoint } from '#lib/model';
import { packTopology } from './topology';
import type { AgentState, SceneDefinition } from '#lib/model';
import type { FieldPointer } from './input';
import { ALL_METRICS_MASK } from './metric-demand';

export const PARTICLE_BYTES = 64;
export { interactionRadii } from '#lib/model';
export const METRIC_BYTES = 64;
export const SPECIES_ROWS = 64;
export const HISTORY_SAMPLES = 64;
export const HISTORY_SAMPLE_BYTES = 32;
export const METRIC_ORDER = [
	'speed',
	'turnRate',
	'acceleration',
	'neighborCount',
	'density',
	'anisotropy',
	'polarization',
	'radialFlow',
	'headingAzimuth',
	'centerDistance',
	'centerBearing',
	'flowOrbit',
	'centerOrbitAngle',
	'centerRadialSpeed',
	'speedContrast'
] as const;

export function packParticles(
	agents: AgentState[],
	scene: SceneDefinition,
	generation: number,
	capacity = agents.length
) {
	const result = new ArrayBuffer(Math.max(1, capacity) * PARTICLE_BYTES);
	const f = new Float32Array(result),
		u = new Uint32Array(result);
	const keys = new Map(scene.species.map((s, i) => [s.key, i]));
	agents.forEach((agent, i) => {
		const offset = i * 16;
		f.set(agent.position, offset);
		if (isTopologyWorld(scene.world)) {
			f[offset + 3] =
				(agent.triangle ??
					nearestTopologyPoint(topologyMesh(scene.world), agent.position).triangle) + 1;
			f[offset + 7] = agent.orientation ?? 1;
		}
		f.set(agent.velocity, offset + 4);
		f.set(agent.velocity, offset + 8);
		u.set([agent.id, keys.get(agent.speciesKey) ?? 0, 1, generation], offset + 12);
	});
	return result;
}

export function unpackParticles(
	bytes: ArrayBuffer,
	scene: SceneDefinition,
	count: number
): AgentState[] {
	const f = new Float32Array(bytes),
		u = new Uint32Array(bytes);
	return Array.from({ length: count }, (_, i) => ({
		id: u[i * 16 + 12],
		speciesKey: scene.species[u[i * 16 + 13]].key,
		position: [f[i * 16], f[i * 16 + 1], f[i * 16 + 2]],
		velocity: [f[i * 16 + 4], f[i * 16 + 5], f[i * 16 + 6]],
		...(isTopologyWorld(scene.world)
			? {
					triangle: Math.round(f[i * 16 + 3]) - 1,
					orientation: (f[i * 16 + 7] < 0 ? -1 : 1) as 1 | -1
				}
			: {}),
		birth: u[i * 16 + 12]
	}));
}

export function packSpecies(scene: SceneDefinition) {
	const data = new Float32Array(Math.max(1, scene.species.length) * SPECIES_ROWS * 4);
	const queryRadii = interactionRadii(scene);
	const row = (i: number, values: readonly number[]) => data.set(values, i * 4);
	scene.species.forEach((s, i) => {
		const base = i * SPECIES_ROWS;
		row(base, [s.speed, s.force, s.perception, s.size]);
		row(base + 1, [s.separation, s.alignment, s.cohesion, Math.PI]);
		row(base + 2, [s.rebels.fraction, s.rebels.strength, s.rebels.period, s.rebels.duration]);
		row(base + 3, [
			(s.cursor.response === 'ignore' ? 0 : s.cursor.response === 'attract' ? 1 : -1) *
				s.cursor.strength,
			s.cursor.vortex,
			s.trail.opacity,
			s.trail.width
		]);
		row(base + 4, [
			...s.visual.hsl,
			['arrow', 'cone', 'diamond', 'sphere', 'ribbon'].indexOf(s.body)
		]);
		row(base + 5, [s.trail.length, s.cruiseSpeed, 0, 0]);
		row(base + 6, [queryRadii[i], 0, 0, 0]);
		(['hue', 'saturation', 'lightness'] as const).forEach((key, c) => {
			const map = s.visual[key],
				start = base + 8 + c * 10;
			row(start, [METRICS.findIndex((m) => m.id === map.source), ...map.range, map.strength]);
			data.set(sampleCurve(map.curve, 32), (start + 1) * 4);
			row(start + 9, [Number(map.enabled), 0, 0, 0]);
		});
		s.metricRules.slice(0, 2).forEach((rule, j) => {
			const start = base + 38 + j * 12;
			row(start, [
				METRICS.findIndex((m) => m.id === rule.metric),
				['neighbor', 'self', 'difference'].indexOf(rule.role),
				BEHAVIORS.indexOf(rule.behavior),
				rule.strength
			]);
			row(start + 1, [...rule.range, rule.radius ?? s.perception, 1]);
			data.set(sampleCurve(rule.curve, 32), (start + 2) * 4);
		});
	});
	return data;
}

export function packPairRules(scene: SceneDefinition) {
	const data = new Float32Array(Math.max(1, scene.species.length ** 2) * 4);
	scene.species.forEach((source, i) =>
		scene.species.forEach((target, j) => {
			const explicit = scene.speciesRules.find((r) => r.from === source.key && r.to === target.key);
			const fallback =
				source.key === target.key
					? undefined
					: scene.speciesRules.find((r) => r.from === source.key && r.to === '*');
			const rule = explicit ?? fallback;
			if (rule)
				data.set(
					[BEHAVIORS.indexOf(rule.behavior), rule.strength, rule.radius ?? source.perception, 1],
					(i * scene.species.length + j) * 4
				);
		})
	);
	return data;
}

export function gridDefinition(scene: SceneDefinition) {
	const radius = globalInteractionRadius(scene);
	const half = worldBounds(scene.world);
	// Exceptional long-range rules expand their own cell queries, not every cell.
	let width = Math.max(
		...scene.species.map((s) => s.perception),
		(Math.max(...half) * 2) / 32,
		0.1
	);
	let dims = half.map((v) => Math.max(1, Math.ceil((2 * v) / width)));
	while (dims.reduce((a, b) => a * b, 1) > 65536) {
		width *= 1.1;
		dims = half.map((v) => Math.max(1, Math.ceil((2 * v) / width)));
	}
	return {
		radius,
		width,
		dims,
		count: dims.reduce((a, b) => a * b, 1),
		min: half.map((v) => -v),
		half
	};
}

export function historyStride(scene: SceneDefinition) {
	return Math.max(
		1,
		Math.ceil(
			Math.max(...scene.species.map((s) => s.trail.length)) /
				(HISTORY_SAMPLES - 1) /
				scene.dynamics.fixedDt
		)
	);
}

export function packConfig(
	scene: SceneDefinition,
	options: {
		population: number;
		tick: number;
		historyHead: number;
		validHistory: number;
		field?: FieldPointer;
		smoothingAlpha?: number;
		selectedId?: number;
		tool?: 'look' | 'force' | 'obstacle' | 'inspect';
		simulationTime?: number;
		runGeneration?: number;
		historyElapsed?: number;
		sampleHistory?: boolean;
		historyCapacity?: number;
		/** Omitted diagnostic calls retain complete measurements. */
		metricMask?: number;
	},
	derived?: { grid: ReturnType<typeof gridDefinition>; stride: number },
	destination?: Float32Array<ArrayBuffer>
) {
	const prefix = 16 + scene.obstacles.length * 2;
	const topology = destination ? null : packTopology(scene);
	const data = destination ?? new Float32Array(Math.max(18 * 4, prefix * 4 + topology!.length));
	if (topology?.length) data.set(topology, prefix * 4);
	const row = (i: number, values: readonly number[]) => data.set(values, i * 4);
	const g = derived?.grid ?? gridDefinition(scene);
	const kind =
		scene.world.kind === 'volume'
			? { box: 0, sphere: 5, cylinder: 6, torus: 7 }[scene.world.shape]
			: {
					sphere: 1,
					plane: 2,
					cylinder: 3,
					torus: 4,
					mobius: 8,
					klein: 9,
					projective: 10,
					trefoil: 11
				}[scene.world.shape];
	row(0, [options.population, scene.species.length, kind, options.tick]);
	row(1, [
		scene.dynamics.fixedDt,
		scene.world.shape === 'torus'
			? scene.world.tubeRadius
			: 'radius' in scene.world
				? scene.world.radius
				: 0,
		g.radius,
		isTopologyWorld(scene.world) ? (options.field?.triangle ?? -1) + 1 : scene.seed % 0x1000000
	]);
	row(2, [...g.half, 'boundaries' in scene.world && scene.world.boundaries === 'periodic' ? 1 : 0]);
	row(3, [...g.dims, g.count]);
	row(4, [...g.min, g.width]);
	row(5, [
		scene.dynamics.collision,
		1.2,
		scene.world.shape === 'torus' ? scene.world.majorRadius : 0,
		options.selectedId ?? 0
	]);
	row(6, [...(options.field?.position ?? [0, 0, 0]), Number(options.field?.active ?? false)]);
	row(7, [
		Number(scene.forces.enabled),
		scene.forces.power * (options.field?.pressed ? 3 : 1),
		scene.forces.shape === 'ring' ? 1 : 0,
		Math.max(0.1, scene.forces.radius * 0.4)
	]);
	row(8, [...scene.dynamics.orbitAxis, scene.dynamics.noise]);
	const alpha =
		scene.dynamics.metricSmoothingSeconds <= 0
			? 1
			: 1 - Math.exp(-scene.dynamics.fixedDt / scene.dynamics.metricSmoothingSeconds);
	row(9, [
		options.smoothingAlpha ?? alpha,
		scene.obstacles.length,
		scene.obstacleSettings.strength,
		Number(scene.obstacleSettings.enabled)
	]);
	row(10, [
		HISTORY_SAMPLES,
		options.historyHead,
		derived?.stride ?? historyStride(scene),
		options.validHistory
	]);
	row(11, [scene.forces.radius, ...scene.forces.workPlane.normal]);
	row(12, [
		scene.forces.depth + scene.forces.workPlane.offset,
		scene.visual.exposure,
		Number(scene.visual.showBoundary),
		['look', 'force', 'obstacle', 'inspect'].indexOf(options.tool ?? 'look')
	]);
	row(13, [
		['rainbow', 'bands', 'ocean', 'chrome', 'mono'].indexOf(scene.visual.palette),
		Number(scene.visual.bloom),
		options.simulationTime ?? options.tick * scene.dynamics.fixedDt,
		options.metricMask ?? ALL_METRICS_MASK
	]);
	// Raw integer words retain all seed/identity bits and exact tick increments.
	new Uint32Array(data.buffer, data.byteOffset, data.length).set(
		[options.tick >>> 0, scene.seed >>> 0, options.runGeneration ?? 1, options.selectedId ?? 0],
		14 * 4
	);
	const stride = derived?.stride ?? historyStride(scene);
	row(15, [
		options.historyElapsed ?? (options.tick % stride) * scene.dynamics.fixedDt,
		Number(options.sampleHistory ?? options.tick % stride === 0),
		(options.historyCapacity ?? options.population) * HISTORY_SAMPLES,
		Number(scene.visual.showGrid ?? false) | (scene.visual.theme === 'day' ? 2 : 0)
	]);
	scene.obstacles.forEach((o, i) => {
		row(16 + i * 2, [...o.center, o.shape === 'sphere' ? 0 : 1]);
		const face = isTopologyWorld(scene.world)
			? nearestTopologyPoint(topologyMesh(scene.world), o.center, o.triangle).triangle + 1
			: 0;
		row(17 + i * 2, o.shape === 'sphere' ? [o.radius, 0, 0, face] : [...o.halfExtents, face]);
	});
	return data;
}
