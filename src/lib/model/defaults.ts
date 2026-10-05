import type { ChannelMap, SceneDefinition, SpeciesDefinition } from '#lib/model/types';
import { BEHAVIORS } from '#lib/model/types';
import { curvePreset } from '#lib/model/curves';
import { seededRandom } from '#lib/model/random';
import { resizePopulation } from '#lib/model/population';
import { worldInteractionLimit } from '#lib/model/geometry';
import { maxSurfaceObstacleRadius } from '#lib/model/interactions';

function constantChannel(): ChannelMap {
	return {
		enabled: false,
		source: 'constant',
		range: [0, 1],
		strength: 0.75,
		curve: curvePreset('linear')
	};
}
export function createSpecies(
	key: string,
	name = 'New species',
	population = 1000
): SpeciesDefinition {
	return {
		key,
		name,
		population,
		body: 'arrow',
		size: 0.14,
		trail: { length: 1.4, width: 0.045, opacity: 0.35 },
		visual: {
			hsl: [0.47, 0.68, 0.62],
			hue: constantChannel(),
			saturation: constantChannel(),
			lightness: {
				enabled: true,
				source: 'turn-rate',
				range: [0, Math.PI],
				strength: 0.45,
				curve: curvePreset('inverted')
			}
		},
		alignment: 1.2,
		cohesion: 0.6,
		separation: 1.7,
		perception: 3.2,
		speed: 9.6,
		cruiseSpeed: 0.6 * 9.6,
		force: 14.4,
		rebels: { fraction: 0.04, strength: 0.9, period: 8, duration: 1.5 },
		cursor: { response: 'attract', strength: 1, vortex: 0 },
		metricRules: []
	};
}
export function createDefaultScene(): SceneDefinition {
	const shoal = createSpecies('shoal', 'Jade', 3250);
	const amber = createSpecies('amber', 'Amber', 1750);
	amber.visual.hsl = [0.095, 0.83, 0.65];
	amber.speed = 10.8;
	amber.cruiseSpeed = 0.6 * amber.speed;
	amber.perception = 4;
	amber.body = 'diamond';
	return {
		version: 1,
		id: 'open-water',
		name: 'Open Water',
		description: 'Two flocks finding their own rhythm in an open volume.',
		seed: 73419,
		world: { kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' },
		species: [shoal, amber],
		speciesRules: [],
		obstacles: [],
		obstacleSettings: { enabled: true, strength: 9 },
		forces: {
			enabled: true,
			power: 8,
			radius: 4,
			shape: 'disk',
			depth: 0,
			workPlane: { normal: [0, 1, 0], offset: 0 }
		},
		dynamics: {
			fixedDt: 1 / 60,
			maxSubsteps: 4,
			timeScale: 1,
			noise: 0.12,
			collision: 1,
			metricSmoothingSeconds: 0.12,
			orbitAxis: [0, 1, 0]
		},
		visual: {
			quality: 'balanced',
			palette: 'rainbow',
			background: '#080e12',
			exposure: 1,
			showBoundary: false,
			bloom: true
		},
		camera: { target: [0, 0, 0], distance: 54, yaw: 0.65, pitch: 0.42, autoRotate: 0 }
	};
}
function curatedScenes(): SceneDefinition[] {
	const open = createDefaultScene();
	const chase = createDefaultScene();
	chase.id = 'cross-currents';
	chase.name = 'Cross Currents';
	chase.description = 'A small amber flock pursues a faster jade shoal.';
	chase.species[0].population = 4400;
	chase.species[0].speed = 12;
	chase.species[0].cruiseSpeed = 0.6 * chase.species[0].speed;
	chase.species[1].population = 600;
	chase.speciesRules = [
		{ id: 'amber-chase', from: 'amber', to: 'shoal', behavior: 'chase', strength: 1.2, radius: 6 },
		{ id: 'jade-flee', from: 'shoal', to: 'amber', behavior: 'flee', strength: 1.6, radius: 4.5 }
	];
	chase.visual.palette = 'bands';
	chase.camera.distance = 58;
	const sphere = createDefaultScene();
	sphere.id = 'small-planet';
	sphere.name = 'Small Planet';
	sphere.description = 'Tangential flocks follow great-circle geometry on a sphere.';
	sphere.world = { kind: 'surface', shape: 'sphere', radius: 16 };
	sphere.visual.palette = 'ocean';
	sphere.camera.distance = 48;
	sphere.camera.pitch = 0.15;
	sphere.species[0].population = 3500;
	sphere.species[1].population = 1500;
	sphere.species[0].perception = 2.4;
	sphere.species[1].perception = 3;
	sphere.species[0].trail.length = 2.2;
	sphere.species[1].trail.length = 2.2;
	sphere.species[0].visual.lightness = {
		enabled: true,
		source: 'speed',
		range: [0, 6],
		strength: 0.35,
		curve: curvePreset('boost-low')
	};
	const ribbons = createDefaultScene();
	ribbons.id = 'satellites';
	ribbons.name = 'Satellites';
	ribbons.description = 'Three distinct flocks; violet agents orbit their amber neighbors.';
	const violet = createSpecies('violet', 'Violet', 1250);
	violet.visual.hsl = [0.74, 0.65, 0.65];
	violet.body = 'ribbon';
	violet.speed = 8;
	violet.cruiseSpeed = 0.6 * violet.speed;
	ribbons.species[0].population = 2000;
	ribbons.species[1].population = 1750;
	ribbons.species.push(violet);
	for (const species of ribbons.species) {
		species.trail.length = 2.6;
		species.visual.saturation = {
			enabled: true,
			source: 'polarization',
			range: [0, 1],
			strength: 0.65,
			curve: curvePreset('s-curve')
		};
		species.visual.lightness = {
			enabled: true,
			source: 'density',
			range: [0, 2],
			strength: 0.35,
			curve: curvePreset('bell')
		};
	}
	ribbons.speciesRules = [
		{
			id: 'violet-orbit',
			from: 'violet',
			to: 'amber',
			behavior: 'orbit',
			strength: 0.65,
			radius: 5
		}
	];
	ribbons.visual.palette = 'rainbow';
	const murmuration = createDefaultScene();
	murmuration.id = 'murmuration';
	murmuration.name = 'Murmuration';
	murmuration.description = 'A single close-knit flock leaves silver ribbons through the volume.';
	murmuration.species = [createSpecies('silver', 'Silver', 5000)];
	murmuration.species[0].visual.hsl = [0.56, 0.18, 0.78];
	murmuration.species[0].alignment = 2;
	murmuration.visual.palette = 'chrome';
	const plane = createDefaultScene();
	plane.id = 'flat-current';
	plane.name = 'Flat Current';
	plane.description = 'Two flocks share a bounded flat XZ surface with reflected edges.';
	plane.world = { kind: 'surface', shape: 'plane', halfExtents: [18, 18], boundaries: 'reflect' };
	plane.species[0].perception = 1.8;
	plane.species[1].perception = 2.2;
	plane.camera.pitch = 0.9;
	const cylinder = createDefaultScene();
	cylinder.id = 'barrel-flow';
	cylinder.name = 'Barrel Flow';
	cylinder.description = 'Intrinsic flocks wrap a cylinder while reflecting at its axial ends.';
	cylinder.world = { kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 14 };
	cylinder.species[0].perception = 2.4;
	cylinder.species[1].perception = 3;
	for (const species of cylinder.species) species.trail.length = 2.2;
	cylinder.visual.palette = 'ocean';
	cylinder.camera.distance = 54;
	cylinder.camera.pitch = 0.25;
	const torus = createDefaultScene();
	torus.id = 'ring-currents';
	torus.name = 'Ring Currents';
	torus.description =
		'Teal and amber ribbons discover curved local currents on a ring torus. Distances use the tested local midpoint approximation.';
	torus.world = { kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 };
	torus.forces.radius = 2.2;
	torus.forces.power = 2.2;
	torus.species[0].population = 3000;
	torus.species[1].population = 2000;
	for (const species of torus.species) {
		species.perception = 2.2;
		species.alignment = 2.2;
		species.cohesion = 0.3;
		species.separation = 1.9;
		species.cruiseSpeed = 0.65 * species.speed;
		species.rebels.fraction = 0.02;
		species.trail.length = 2.6;
		species.body = 'ribbon';
	}
	torus.species[0].visual.hsl = [0.46, 0.7, 0.62];
	torus.species[1].visual.hsl = [0.105, 0.85, 0.65];
	torus.speciesRules = [
		{
			id: 'teal-follow',
			from: 'shoal',
			to: 'amber',
			behavior: 'follow',
			strength: 0.35,
			radius: 2.2
		},
		{ id: 'amber-orbit', from: 'amber', to: 'shoal', behavior: 'orbit', strength: 0.3, radius: 2.2 }
	];
	torus.dynamics.noise = 0.025;
	torus.camera = { target: [0, 0, 0], distance: 80, yaw: 0.65, pitch: 0.7, autoRotate: 0 };
	const chromatic = createDefaultScene();
	chromatic.id = 'chromatic-flow';
	chromatic.name = 'Chromatic Flow';
	chromatic.description =
		'Direction paints hue, local alignment sets saturation, and turning changes brightness. Each channel has its own curve.';
	chromatic.speciesRules = [
		{
			id: 'chromatic-orbit',
			from: 'amber',
			to: 'shoal',
			behavior: 'orbit',
			strength: 0.5,
			radius: 5
		}
	];
	for (const species of chromatic.species) {
		species.visual.hue = {
			enabled: true,
			source: 'heading-azimuth',
			range: [0, 1],
			strength: 1,
			curve: curvePreset('linear')
		};
		species.visual.saturation = {
			enabled: true,
			source: 'polarization',
			range: [0, 1],
			strength: 0.65,
			curve: curvePreset('boost-low')
		};
		species.trail.length = 2;
	}
	const vortex = cloneScene(torus);
	vortex.id = 'vortex-colors';
	vortex.name = 'Vortex Colors';
	vortex.description =
		'Inherited center-relative color maps: orbit angle, radial speed, and speed contrast reveal local motion.';
	vortex.visual.palette = 'ocean';
	for (const species of vortex.species) {
		species.visual.hue = {
			enabled: true,
			source: 'center-orbit-angle',
			range: [0, 1],
			strength: 1,
			curve: curvePreset('linear')
		};
		species.visual.saturation = {
			enabled: true,
			source: 'speed-contrast',
			range: [0, 0.5],
			strength: 0.6,
			curve: curvePreset('boost-high')
		};
		species.visual.lightness = {
			enabled: true,
			source: 'center-radial-speed',
			range: [-species.speed, species.speed],
			strength: 0.55,
			curve: curvePreset('s-curve')
		};
	}
	return [murmuration, open, ribbons, chase, sphere, plane, cylinder, torus, chromatic, vortex];
}
export const CURATED_SCENES: readonly SceneDefinition[] = curatedScenes();
export function cloneScene(scene: SceneDefinition): SceneDefinition {
	return structuredClone(scene);
}

/** Seeded, curated parameter families preserve the chosen world and presentation. */
export function discoverScene(
	seed: number,
	base: SceneDefinition = createDefaultScene()
): SceneDefinition {
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
		throw new Error('Discovery seed must be a uint32.');
	const random = seededRandom(seed);
	const scene = cloneScene(base);
	scene.seed = seed >>> 0;
	scene.id = `discovery-${scene.seed}`;
	scene.name = `Discovery ${scene.seed}`;
	scene.description = 'A reproducible collection of species and directed relationships.';
	const count = 2 + Math.floor(random() * 3);
	const total = base.species.reduce((sum, species) => sum + species.population, 0);
	const maximumRadius =
		scene.world.kind === 'volume' || scene.world.shape === 'plane'
			? Math.min(...scene.world.halfExtents) * 0.6
			: Math.min(
					worldInteractionLimit(scene.world) * 0.7,
					scene.world.shape === 'cylinder' ? scene.world.halfHeight * 0.6 : Infinity
				);
	const names = ['Jade', 'Amber', 'Violet', 'Pearl'];
	const colorFamily = Math.floor(random() * 4);
	scene.visual.palette = (['rainbow', 'bands', 'ocean', 'chrome', 'mono'] as const)[
		Math.floor(random() * 5)
	];
	scene.species = Array.from({ length: count }, (_, i) => {
		const species = createSpecies(`discovery-${i}`, names[i], 20 + Math.floor(random() * 80));
		if (scene.world.kind === 'surface') species.size = Math.min(species.size, maximumRadius / 8);
		species.visual.hsl = [
			(0.12 + i / count + random() * 0.1) % 1,
			0.45 + random() * 0.4,
			0.5 + random() * 0.2
		];
		species.alignment = 0.7 + random() * 1.7;
		species.cohesion = 0.25 + random() * 0.8;
		species.separation = 1 + random() * 1.8;
		species.speed = 6.5 + random() * 6;
		species.cruiseSpeed = (0.5 + random() * 0.25) * species.speed;
		species.force = 12 + random() * 8;
		species.perception = Math.min(maximumRadius, 2.1 + random() * 2.8);
		species.rebels.fraction = random() * 0.12;
		species.cursor.response = random() < 0.25 ? 'repel' : 'attract';
		species.body = (['arrow', 'cone', 'diamond', 'ribbon'] as const)[Math.floor(random() * 4)];
		if (colorFamily > 0) {
			species.visual.hue = {
				enabled: true,
				source:
					colorFamily === 1
						? 'heading-azimuth'
						: colorFamily === 2
							? 'center-orbit-angle'
							: 'density',
				range: [0, colorFamily === 3 ? 4 : 1],
				strength: 0.75 + random() * 0.25,
				curve: curvePreset('linear')
			};
			species.visual.saturation = {
				enabled: true,
				source: colorFamily === 2 ? 'speed-contrast' : 'polarization',
				range: [0, 1],
				strength: 0.4 + random() * 0.35,
				curve: curvePreset('boost-low')
			};
		}
		if (random() < 0.35)
			species.metricRules = [
				{
					id: `metric-${i}`,
					metric: 'speed-contrast',
					role: (['neighbor', 'self', 'difference'] as const)[Math.floor(random() * 3)],
					range: [0, 1],
					curve: curvePreset('boost-high'),
					behavior: random() < 0.5 ? 'align' : 'orbit',
					strength: 0.15 + random() * 0.3,
					radius: null
				}
			];
		return species;
	});
	scene.speciesRules = [];
	const discoveryBehaviors = BEHAVIORS.filter((behavior) => behavior !== 'ignore');
	for (let i = 0; i < count; i++) {
		if (random() < 0.75)
			scene.speciesRules.push({
				id: `link-${i}`,
				from: scene.species[i].key,
				to: scene.species[(i + 1) % count].key,
				behavior: discoveryBehaviors[Math.floor(random() * discoveryBehaviors.length)],
				strength: 0.4 + random() * 0.7,
				radius: null
			});
	}
	if (scene.world.kind === 'surface' && scene.world.shape === 'torus') {
		scene.forces.radius = Math.min(scene.forces.radius, maximumRadius);
		const obstacleLimit = maxSurfaceObstacleRadius(scene);
		for (const obstacle of scene.obstacles)
			if (obstacle.shape === 'sphere') obstacle.radius = Math.min(obstacle.radius, obstacleLimit);
	}
	return resizePopulation(scene, total);
}
