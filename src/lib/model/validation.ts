import type { SceneDefinition } from '#lib/model/types';
import { BEHAVIORS } from '#lib/model/types';
import { METRIC_IDS } from '#lib/model/metrics';
import { MAX_POPULATION } from '#lib/model/population';
import { interactionRadii, surfaceObstacleMargin } from '#lib/model/interactions';

export interface ValidationIssue {
	path: string;
	message: string;
}
export type SceneValidationResult =
	{ ok: true; scene: SceneDefinition; issues: [] } | { ok: false; issues: ValidationIssue[] };
type ObjectValue = Record<string, unknown>;

/** Finite validation; missing prerelease-v1 additions normalize without mutating the input. */
export function validateScene(value: unknown): SceneValidationResult {
	const issues: ValidationIssue[] = [];
	const fail = (path: string, message: string) => {
		if (issues.length < 100) issues.push({ path, message });
	};
	const object = (
		input: unknown,
		path: string,
		keys: readonly string[]
	): ObjectValue | undefined => {
		if (
			!input ||
			typeof input !== 'object' ||
			Array.isArray(input) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(input))
		) {
			fail(path, 'Expected a plain object.');
			return;
		}
		for (const key of Object.keys(input))
			if (!keys.includes(key)) fail(`${path}.${key}`, 'Unknown property.');
		return input as ObjectValue;
	};
	const numeric = (input: unknown, path: string, low: number, high: number, integer = false) => {
		if (
			typeof input !== 'number' ||
			!Number.isFinite(input) ||
			input < low ||
			input > high ||
			(integer && !Number.isSafeInteger(input))
		)
			fail(
				path,
				`Expected ${integer ? 'an integer' : 'a finite number'} between ${low} and ${high}.`
			);
	};
	const text = (input: unknown, path: string, maximum: number, empty = false) => {
		if (typeof input !== 'string' || input.length > maximum || (!empty && !input.trim()))
			fail(path, `Expected ${empty ? '' : 'nonempty '}text of at most ${maximum} characters.`);
	};
	const identifier = (input: unknown, path: string) => {
		if (typeof input !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input))
			fail(path, 'Expected a stable identifier (letters, digits, underscore or dash).');
	};
	const boolean = (input: unknown, path: string) => {
		if (typeof input !== 'boolean') fail(path, 'Expected a boolean.');
	};
	const enumeration = (input: unknown, path: string, choices: readonly string[]) => {
		if (typeof input !== 'string' || !choices.includes(input))
			fail(path, `Expected one of: ${choices.join(', ')}.`);
	};
	const tuple = (input: unknown, path: string, length: number, low: number, high: number) => {
		if (!Array.isArray(input) || input.length !== length) {
			fail(path, `Expected ${length} numbers.`);
			return;
		}
		input.forEach((part, index) => numeric(part, `${path}[${index}]`, low, high));
	};
	const range = (input: unknown, path: string) => {
		tuple(input, path, 2, -1e6, 1e6);
		if (
			Array.isArray(input) &&
			input.length === 2 &&
			typeof input[0] === 'number' &&
			typeof input[1] === 'number' &&
			!(input[1] > input[0])
		)
			fail(path, 'Range maximum must exceed minimum.');
	};
	const unitVector = (input: unknown, path: string) => {
		tuple(input, path, 3, -1, 1);
		if (
			Array.isArray(input) &&
			input.length === 3 &&
			input.every(Number.isFinite) &&
			Math.abs(Math.hypot(...input) - 1) > 1e-4
		)
			fail(path, 'Expected a unit vector.');
	};
	const curve = (input: unknown, path: string) => {
		const data = object(input, path, ['points']);
		if (!data) return;
		if (!Array.isArray(data.points) || data.points.length < 2 || data.points.length > 32) {
			fail(`${path}.points`, 'Expected 2–32 control points.');
			return;
		}
		data.points.forEach((point, index) => {
			tuple(point, `${path}.points[${index}]`, 2, 0, 1);
			if (
				index > 0 &&
				Array.isArray(point) &&
				Array.isArray(data.points) &&
				typeof point[0] === 'number' &&
				typeof data.points[index - 1]?.[0] === 'number' &&
				!(point[0] > data.points[index - 1]?.[0])
			)
				fail(`${path}.points[${index}]`, 'Control point x positions must increase strictly.');
		});
		if (data.points[0]?.[0] !== 0 || data.points.at(-1)?.[0] !== 1)
			fail(`${path}.points`, 'Curve must span x=0 to x=1.');
	};
	const channel = (input: unknown, path: string) => {
		const data = object(input, path, ['enabled', 'source', 'range', 'strength', 'curve']);
		if (!data) return;
		boolean(data.enabled, `${path}.enabled`);
		enumeration(data.source, `${path}.source`, ['constant', ...METRIC_IDS]);
		range(data.range, `${path}.range`);
		numeric(data.strength, `${path}.strength`, 0, 1);
		curve(data.curve, `${path}.curve`);
	};
	const array = (input: unknown, path: string, maximum: number): unknown[] => {
		if (!Array.isArray(input) || input.length > maximum) {
			fail(path, `Expected an array with at most ${maximum} items.`);
			return [];
		}
		return input;
	};
	const scene = object(value, 'scene', [
		'version',
		'id',
		'name',
		'description',
		'seed',
		'world',
		'species',
		'speciesRules',
		'obstacles',
		'obstacleSettings',
		'forces',
		'dynamics',
		'visual',
		'camera'
	]);
	if (!scene) return { ok: false, issues };
	if (scene.version !== 1)
		fail(
			'scene.version',
			'Only Swarm3D scene version 1 is supported; legacy scenes are not imported.'
		);
	identifier(scene.id, 'scene.id');
	text(scene.name, 'scene.name', 120);
	text(scene.description, 'scene.description', 2000, true);
	numeric(scene.seed, 'scene.seed', 0, 0xffffffff, true);
	let interactionLimit = Infinity;
	let interactionLabel = '';
	const world = object(scene.world, 'scene.world', [
		'kind',
		'shape',
		'halfExtents',
		'boundaries',
		'radius',
		'halfHeight',
		'majorRadius',
		'tubeRadius'
	]);
	if (world?.kind === 'volume') {
		if (world.shape !== 'box') fail('scene.world.shape', 'Volume shape must be box.');
		tuple(world.halfExtents, 'scene.world.halfExtents', 3, 0.1, 10000);
		enumeration(world.boundaries, 'scene.world.boundaries', ['reflect', 'periodic']);
		if (
			'radius' in world ||
			'halfHeight' in world ||
			'majorRadius' in world ||
			'tubeRadius' in world
		)
			fail('scene.world', 'Surface properties do not apply to a box.');
	} else if (world?.kind === 'surface') {
		if (world.shape === 'plane') {
			tuple(world.halfExtents, 'scene.world.halfExtents', 2, 0.1, 10000);
			enumeration(world.boundaries, 'scene.world.boundaries', ['reflect', 'periodic']);
			if (
				'radius' in world ||
				'halfHeight' in world ||
				'majorRadius' in world ||
				'tubeRadius' in world
			)
				fail('scene.world', 'Curved surface properties do not apply to a plane.');
		} else if (world.shape === 'sphere' || world.shape === 'cylinder') {
			numeric(world.radius, 'scene.world.radius', 0.1, 10000);
			interactionLabel = world.shape === 'sphere' ? 'πR/2' : 'πR';
			if (typeof world.radius === 'number')
				interactionLimit = world.radius * Math.PI * (world.shape === 'sphere' ? 0.5 : 1);
			if (
				'halfExtents' in world ||
				'boundaries' in world ||
				'majorRadius' in world ||
				'tubeRadius' in world
			)
				fail('scene.world', 'Plane/box properties do not apply to this surface.');
			if (world.shape === 'cylinder')
				numeric(world.halfHeight, 'scene.world.halfHeight', 0.1, 10000);
			else if ('halfHeight' in world)
				fail('scene.world.halfHeight', 'Axial height does not apply to a sphere.');
		} else if (world.shape === 'torus') {
			numeric(world.majorRadius, 'scene.world.majorRadius', 2, 10000);
			numeric(world.tubeRadius, 'scene.world.tubeRadius', 1, 5000);
			if (
				typeof world.majorRadius === 'number' &&
				typeof world.tubeRadius === 'number' &&
				(world.majorRadius < 2 * world.tubeRadius || world.majorRadius > 10 * world.tubeRadius)
			)
				fail('scene.world', 'Torus major/tube radius ratio must remain between 2 and 10.');
			interactionLabel = '0.3r (torus tube radius)';
			if (typeof world.tubeRadius === 'number') interactionLimit = 0.3 * world.tubeRadius;
			if (['radius', 'halfHeight', 'halfExtents', 'boundaries'].some((key) => key in world))
				fail('scene.world', 'Other surface properties do not apply to a torus.');
		} else fail('scene.world.shape', 'Expected sphere, plane, cylinder or torus.');
	} else fail('scene.world.kind', 'Expected volume or surface.');
	const radius = (input: unknown, path: string, nullable = false) => {
		if (nullable && input === null) return;
		numeric(input, path, 0.001, 10000);
		if (typeof input === 'number' && input >= interactionLimit)
			fail(path, `Surface interaction ranges must be strictly below ${interactionLabel}.`);
	};
	const species = array(scene.species, 'scene.species', 16);
	if (species.length === 0) fail('scene.species', 'A scene needs at least one species.');
	const speciesKeys = new Set<string>();
	let population = 0;
	species.forEach((entry, index) => {
		const path = `scene.species[${index}]`;
		const data = object(entry, path, [
			'key',
			'name',
			'population',
			'body',
			'size',
			'trail',
			'visual',
			'alignment',
			'cohesion',
			'separation',
			'perception',
			'speed',
			'cruiseSpeed',
			'force',
			'rebels',
			'cursor',
			'metricRules'
		]);
		if (!data) return;
		identifier(data.key, `${path}.key`);
		if (typeof data.key === 'string') {
			if (speciesKeys.has(data.key)) fail(`${path}.key`, 'Duplicate species key.');
			speciesKeys.add(data.key);
		}
		text(data.name, `${path}.name`, 80);
		numeric(data.population, `${path}.population`, 0, MAX_POPULATION, true);
		if (typeof data.population === 'number') population += data.population;
		enumeration(data.body, `${path}.body`, ['arrow', 'cone', 'diamond', 'sphere', 'ribbon']);
		numeric(data.size, `${path}.size`, 0.001, 100);
		if (typeof data.size === 'number' && world?.kind === 'surface') {
			if (
				world.shape === 'plane' &&
				Array.isArray(world.halfExtents) &&
				data.size >= Math.min(...world.halfExtents)
			)
				fail(`${path}.size`, 'Body radius must be smaller than both plane half-extents.');
			if (
				world.shape === 'cylinder' &&
				typeof world.halfHeight === 'number' &&
				data.size >= world.halfHeight
			)
				fail(`${path}.size`, 'Body radius must be smaller than cylinder half-height.');
		}
		if (typeof data.size === 'number' && 4 * data.size >= interactionLimit)
			fail(`${path}.size`, `Body collision reach must remain below ${interactionLabel}.`);
		const trail = object(data.trail, `${path}.trail`, ['length', 'width', 'opacity']);
		if (trail) {
			numeric(trail.length, `${path}.trail.length`, 0, 10);
			numeric(trail.width, `${path}.trail.width`, 0.001, 10);
			numeric(trail.opacity, `${path}.trail.opacity`, 0, 1);
		}
		const visual = object(data.visual, `${path}.visual`, ['hsl', 'hue', 'saturation', 'lightness']);
		if (visual) {
			tuple(visual.hsl, `${path}.visual.hsl`, 3, 0, 1);
			for (const key of ['hue', 'saturation', 'lightness'])
				channel(visual[key], `${path}.visual.${key}`);
		}
		for (const key of ['alignment', 'cohesion', 'separation'])
			numeric(data[key], `${path}.${key}`, 0, 20);
		radius(data.perception, `${path}.perception`);
		numeric(data.speed, `${path}.speed`, 0.001, 1000);
		const cruiseSpeed = Object.hasOwn(data, 'cruiseSpeed')
			? data.cruiseSpeed
			: typeof data.speed === 'number'
				? 0.3 * data.speed
				: undefined;
		numeric(cruiseSpeed, `${path}.cruiseSpeed`, 0, 1000);
		if (
			typeof cruiseSpeed === 'number' &&
			typeof data.speed === 'number' &&
			cruiseSpeed > data.speed
		)
			fail(`${path}.cruiseSpeed`, 'Cruise speed cannot exceed maximum speed.');
		numeric(data.force, `${path}.force`, 0, 1000);
		const rebels = object(data.rebels, `${path}.rebels`, [
			'fraction',
			'strength',
			'period',
			'duration'
		]);
		if (rebels) {
			numeric(rebels.fraction, `${path}.rebels.fraction`, 0, 1);
			numeric(rebels.strength, `${path}.rebels.strength`, 0, 1);
			numeric(rebels.period, `${path}.rebels.period`, 0.01, 1000);
			numeric(rebels.duration, `${path}.rebels.duration`, 0, 1000);
			if (
				typeof rebels.duration === 'number' &&
				typeof rebels.period === 'number' &&
				rebels.duration > rebels.period
			)
				fail(`${path}.rebels.duration`, 'Rebel duration cannot exceed its period.');
		}
		const cursor = object(data.cursor, `${path}.cursor`, ['response', 'strength', 'vortex']);
		if (cursor) {
			enumeration(cursor.response, `${path}.cursor.response`, ['attract', 'repel', 'ignore']);
			numeric(cursor.strength, `${path}.cursor.strength`, 0, 20);
			numeric(cursor.vortex, `${path}.cursor.vortex`, -20, 20);
		}
		const ruleIds = new Set<string>();
		array(data.metricRules, `${path}.metricRules`, 2).forEach((entry, ruleIndex) => {
			const rulePath = `${path}.metricRules[${ruleIndex}]`;
			const rule = object(entry, rulePath, [
				'id',
				'metric',
				'role',
				'range',
				'curve',
				'behavior',
				'strength',
				'radius'
			]);
			if (!rule) return;
			identifier(rule.id, `${rulePath}.id`);
			if (typeof rule.id === 'string') {
				if (ruleIds.has(rule.id)) fail(`${rulePath}.id`, 'Duplicate metric rule ID.');
				ruleIds.add(rule.id);
			}
			enumeration(rule.metric, `${rulePath}.metric`, METRIC_IDS);
			enumeration(rule.role, `${rulePath}.role`, ['neighbor', 'self', 'difference']);
			range(rule.range, `${rulePath}.range`);
			curve(rule.curve, `${rulePath}.curve`);
			enumeration(rule.behavior, `${rulePath}.behavior`, BEHAVIORS);
			numeric(rule.strength, `${rulePath}.strength`, 0, 20);
			radius(rule.radius, `${rulePath}.radius`, true);
		});
	});
	if (population < 1 || population > MAX_POPULATION)
		fail('scene.species', `Total population must be 1–${MAX_POPULATION}.`);
	const pairIds = new Set<string>(),
		ruleIds = new Set<string>();
	array(scene.speciesRules, 'scene.speciesRules', 272).forEach((entry, index) => {
		const path = `scene.speciesRules[${index}]`;
		const rule = object(entry, path, ['id', 'from', 'to', 'behavior', 'strength', 'radius']);
		if (!rule) return;
		identifier(rule.id, `${path}.id`);
		if (typeof rule.id === 'string') {
			if (ruleIds.has(rule.id)) fail(`${path}.id`, 'Duplicate rule ID.');
			ruleIds.add(rule.id);
		}
		if (typeof rule.from !== 'string' || !speciesKeys.has(rule.from))
			fail(`${path}.from`, 'Unknown source species.');
		if (rule.to !== '*' && (typeof rule.to !== 'string' || !speciesKeys.has(rule.to)))
			fail(`${path}.to`, 'Unknown target species.');
		if (rule.from === rule.to)
			fail(
				path,
				'Directed species rules target other species; use metric rules for same-species behavior.'
			);
		const pair = `${rule.from}:${rule.to}`;
		if (pairIds.has(pair)) fail(path, 'Duplicate source/target pair.');
		pairIds.add(pair);
		enumeration(rule.behavior, `${path}.behavior`, BEHAVIORS);
		numeric(rule.strength, `${path}.strength`, 0, 20);
		radius(rule.radius, `${path}.radius`, true);
	});
	const obstacleIds = new Set<string>();
	array(scene.obstacles, 'scene.obstacles', 32).forEach((entry, index) => {
		const path = `scene.obstacles[${index}]`,
			data = object(entry, path, ['id', 'shape', 'center', 'radius', 'halfExtents']);
		if (!data) return;
		identifier(data.id, `${path}.id`);
		if (typeof data.id === 'string') {
			if (obstacleIds.has(data.id)) fail(`${path}.id`, 'Duplicate obstacle ID.');
			obstacleIds.add(data.id);
		}
		const coordinateLimit = world?.kind === 'surface' && world.shape === 'torus' ? 15000 : 10000;
		tuple(data.center, `${path}.center`, 3, -coordinateLimit, coordinateLimit);
		if (
			world?.kind === 'surface' &&
			world.shape === 'sphere' &&
			typeof world.radius === 'number' &&
			Array.isArray(data.center) &&
			data.center.every(Number.isFinite) &&
			data.center.length === 3 &&
			Math.abs(Math.hypot(...data.center) - world.radius) > Math.max(1e-5, world.radius * 1e-5)
		)
			fail(`${path}.center`, 'Surface obstacle center must lie on the sphere.');
		if (
			world?.kind === 'surface' &&
			Array.isArray(data.center) &&
			data.center.length === 3 &&
			data.center.every(Number.isFinite)
		) {
			if (
				world.shape === 'torus' &&
				typeof world.majorRadius === 'number' &&
				typeof world.tubeRadius === 'number'
			) {
				const tubeDistance = Math.hypot(
					Math.hypot(data.center[0], data.center[2]) - world.majorRadius,
					data.center[1]
				);
				if (Math.abs(tubeDistance - world.tubeRadius) > Math.max(1e-5, world.tubeRadius * 1e-5))
					fail(`${path}.center`, 'Surface obstacle center must lie on the torus.');
			}
			if (
				world.shape === 'cylinder' &&
				typeof world.radius === 'number' &&
				typeof world.halfHeight === 'number'
			) {
				const tolerance = Math.max(1e-5, world.radius * 1e-5);
				if (
					Math.abs(Math.hypot(data.center[0], data.center[2]) - world.radius) > tolerance ||
					Math.abs(data.center[1]) > world.halfHeight + tolerance
				)
					fail(`${path}.center`, 'Surface obstacle center must lie on the bounded cylinder.');
			}
			if (
				world.shape === 'plane' &&
				Array.isArray(world.halfExtents) &&
				world.halfExtents.length === 2 &&
				world.halfExtents.every(Number.isFinite)
			) {
				const tolerance = Math.max(1e-5, Math.max(...world.halfExtents) * 1e-5);
				if (
					Math.abs(data.center[1]) > tolerance ||
					Math.abs(data.center[0]) > world.halfExtents[0] + tolerance ||
					Math.abs(data.center[2]) > world.halfExtents[1] + tolerance
				)
					fail(`${path}.center`, 'Surface obstacle center must lie on the bounded XZ plane.');
			}
		}
		if (data.shape === 'sphere') {
			radius(data.radius, `${path}.radius`);
			if ('halfExtents' in data) fail(path, 'Sphere obstacle cannot have box extents.');
		} else if (data.shape === 'box') {
			if (world?.kind === 'surface')
				fail(
					`${path}.shape`,
					'Surfaces support intrinsic disk/geodesic cap obstacles, not box primitives.'
				);
			tuple(data.halfExtents, `${path}.halfExtents`, 3, 0.001, 10000);
			if ('radius' in data) fail(path, 'Box obstacle cannot have sphere radius.');
		} else fail(`${path}.shape`, 'Expected sphere or box.');
	});
	const obstacles = object(scene.obstacleSettings, 'scene.obstacleSettings', [
		'enabled',
		'strength'
	]);
	if (obstacles) {
		boolean(obstacles.enabled, 'scene.obstacleSettings.enabled');
		numeric(obstacles.strength, 'scene.obstacleSettings.strength', 0, 1000);
	}
	const forces = object(scene.forces, 'scene.forces', [
		'enabled',
		'power',
		'radius',
		'shape',
		'depth',
		'workPlane'
	]);
	if (forces) {
		boolean(forces.enabled, 'scene.forces.enabled');
		numeric(forces.power, 'scene.forces.power', 0, 1000);
		radius(forces.radius, 'scene.forces.radius');
		enumeration(forces.shape, 'scene.forces.shape', ['disk', 'ring']);
		numeric(forces.depth, 'scene.forces.depth', -10000, 10000);
		const plane = object(forces.workPlane, 'scene.forces.workPlane', ['normal', 'offset']);
		if (plane) {
			unitVector(plane.normal, 'scene.forces.workPlane.normal');
			numeric(plane.offset, 'scene.forces.workPlane.offset', -10000, 10000);
		}
	}
	const dynamics = object(scene.dynamics, 'scene.dynamics', [
		'fixedDt',
		'maxSubsteps',
		'timeScale',
		'noise',
		'collision',
		'metricSmoothingSeconds',
		'orbitAxis'
	]);
	if (dynamics) {
		numeric(dynamics.fixedDt, 'scene.dynamics.fixedDt', 1 / 240, 0.1);
		numeric(dynamics.maxSubsteps, 'scene.dynamics.maxSubsteps', 1, 16, true);
		numeric(dynamics.timeScale, 'scene.dynamics.timeScale', 0.01, 4);
		numeric(dynamics.noise, 'scene.dynamics.noise', 0, 20);
		numeric(dynamics.collision, 'scene.dynamics.collision', 0, 20);
		numeric(dynamics.metricSmoothingSeconds, 'scene.dynamics.metricSmoothingSeconds', 0, 10);
		unitVector(dynamics.orbitAxis, 'scene.dynamics.orbitAxis');
		if (
			world?.kind === 'surface' &&
			world.shape === 'sphere' &&
			Number.isFinite(interactionLimit) &&
			typeof dynamics.fixedDt === 'number'
		)
			species.forEach((entry, index) => {
				if (
					entry &&
					typeof entry === 'object' &&
					'speed' in entry &&
					typeof entry.speed === 'number' &&
					entry.speed * (dynamics.fixedDt as number) >= interactionLimit
				)
					fail(
						`scene.species[${index}].speed`,
						'A sphere tick must travel strictly less than πR/2 to preserve unambiguous history transport.'
					);
			});
	}
	const visual = object(scene.visual, 'scene.visual', [
		'quality',
		'palette',
		'background',
		'exposure',
		'showBoundary',
		'bloom'
	]);
	if (visual) {
		enumeration(
			Object.hasOwn(visual, 'quality') ? visual.quality : 'balanced',
			'scene.visual.quality',
			['fast', 'balanced', 'sharp']
		);
		enumeration(visual.palette, 'scene.visual.palette', [
			'chrome',
			'ocean',
			'bands',
			'rainbow',
			'mono'
		]);
		if (typeof visual.background !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(visual.background))
			fail('scene.visual.background', 'Expected a six-digit hex color.');
		numeric(visual.exposure, 'scene.visual.exposure', 0.1, 4);
		boolean(visual.showBoundary, 'scene.visual.showBoundary');
		boolean(visual.bloom, 'scene.visual.bloom');
	}
	const camera = object(scene.camera, 'scene.camera', [
		'target',
		'distance',
		'yaw',
		'pitch',
		'autoRotate'
	]);
	if (camera) {
		tuple(camera.target, 'scene.camera.target', 3, -10000, 10000);
		numeric(camera.distance, 'scene.camera.distance', 0.01, 100000);
		numeric(camera.yaw, 'scene.camera.yaw', -1e6, 1e6);
		numeric(camera.pitch, 'scene.camera.pitch', -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
		numeric(camera.autoRotate, 'scene.camera.autoRotate', -2, 2);
	}
	if (!issues.length && world?.kind === 'surface' && world.shape === 'torus') {
		const candidate = scene as unknown as SceneDefinition;
		interactionRadii(candidate).forEach((reach, index) => {
			if (reach >= interactionLimit)
				fail(
					`scene.species[${index}].size`,
					'Complete torus contact/query reach must remain strictly below 0.3r.'
				);
		});
		const margin = surfaceObstacleMargin(candidate);
		if (margin + 0.001 >= interactionLimit)
			fail(
				'scene.species',
				'Torus body and avoidance margins must leave room for a positive legal obstacle radius below 0.3r.'
			);
		if (candidate.obstacleSettings.enabled && candidate.obstacleSettings.strength > 0)
			candidate.obstacles.forEach((obstacle, index) => {
				if (obstacle.shape === 'sphere' && obstacle.radius + margin >= interactionLimit)
					fail(
						`scene.obstacles[${index}].radius`,
						'Active torus obstacle force reach, including body and avoidance margins, must remain strictly below 0.3r.'
					);
			});
	}
	if (issues.length) return { ok: false, issues };
	const normalized = structuredClone(value) as SceneDefinition;
	for (const species of normalized.species)
		if (!Object.hasOwn(species, 'cruiseSpeed')) species.cruiseSpeed = 0.3 * species.speed;
	if (!Object.hasOwn(normalized.visual, 'quality')) normalized.visual.quality = 'balanced';
	return { ok: true, scene: normalized, issues: [] };
}
export class SceneValidationError extends Error {
	constructor(public readonly issues: ValidationIssue[]) {
		super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
		this.name = 'SceneValidationError';
	}
}
export function assertScene(value: unknown): SceneDefinition {
	const result = validateScene(value);
	if (!result.ok) throw new SceneValidationError(result.issues);
	return result.scene;
}
export const parseScene = assertScene;
