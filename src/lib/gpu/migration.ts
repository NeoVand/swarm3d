import {
	worldBounds,
	worldDisplacement,
	worldExp,
	scale,
	torusChart,
	torusPoint,
	torusShortAngle
} from '#lib/model';
import type { AgentState, SceneDefinition, Vec3 } from '#lib/model';
import {
	HISTORY_SAMPLES,
	HISTORY_SAMPLE_BYTES,
	PARTICLE_BYTES,
	METRIC_BYTES,
	packParticles
} from './packing';

/** Infrequent structural edits remap runtime history by stable identity, never by buffer slot. */
export function migrateRuntime(
	agents: AgentState[],
	scene: SceneDefinition,
	generation: number,
	capacity: number,
	previous: {
		particles: ArrayBuffer;
		metrics: ArrayBuffer;
		history: ArrayBuffer;
		head: number;
		valid: number;
		oldInterval: number;
		newInterval: number;
		/** Physical time since the newest old sample; supplied values anchor the new head at now. */
		headElapsed?: number;
	}
) {
	if (
		!Number.isFinite(previous.oldInterval) ||
		previous.oldInterval <= 0 ||
		!Number.isFinite(previous.newInterval) ||
		previous.newInterval <= 0 ||
		!Number.isInteger(previous.valid) ||
		previous.valid < 1 ||
		previous.valid > HISTORY_SAMPLES ||
		!Number.isInteger(previous.head) ||
		previous.head < 0 ||
		previous.head >= HISTORY_SAMPLES ||
		(previous.headElapsed !== undefined &&
			(!Number.isFinite(previous.headElapsed) || previous.headElapsed < 0))
	)
		throw new Error('Invalid trajectory sampling times or history bounds.');
	const particles = packParticles(agents, scene, generation, capacity);
	const state = new Float32Array(particles),
		oldState = new Float32Array(previous.particles),
		ids = new Uint32Array(previous.particles);
	const metrics = new Float32Array((capacity * METRIC_BYTES) / 4),
		oldMetrics = new Float32Array(previous.metrics);
	const history = new Float32Array((capacity * HISTORY_SAMPLES * HISTORY_SAMPLE_BYTES) / 4),
		oldHistory = new Float32Array(previous.history);
	const metricStride = METRIC_BYTES / 4;
	const oldColorBase = oldHistory.length / 2;
	const colorBase = capacity * HISTORY_SAMPLES * 4;
	const slots = new Map<number, number>();
	for (let i = 0; i < previous.particles.byteLength / PARTICLE_BYTES; i++)
		slots.set(ids[i * 16 + 12], i);
	const valid = Math.min(
		HISTORY_SAMPLES,
		Math.floor(
			((previous.valid - 1) * previous.oldInterval + (previous.headElapsed ?? 0)) /
				previous.newInterval
		) + 1
	);
	const interpolate = (a: ArrayLike<number>, b: ArrayLike<number>, weight: number) => {
		// A discontinuity token must never be blended into a fictitious generation.
		if (a[3] !== b[3]) return weight < 0.5 ? Array.from(a) : Array.from(b);
		if (scene.world.shape === 'torus') {
			const origin = torusChart(scene.world, [a[0], a[1], a[2]]);
			const destination = torusChart(scene.world, [b[0], b[1], b[2]]);
			return [
				...torusPoint(scene.world, {
					theta: origin.theta + torusShortAngle(destination.theta - origin.theta) * weight,
					phi: origin.phi + torusShortAngle(destination.phi - origin.phi) * weight
				}),
				a[3]
			];
		}
		if (scene.world.shape === 'cylinder') {
			const origin: Vec3 = [a[0], a[1], a[2]];
			const destination: Vec3 = [b[0], b[1], b[2]];
			return [
				...worldExp(
					scene.world,
					origin,
					scale(worldDisplacement(scene.world, origin, destination), weight)
				),
				a[3]
			];
		}
		const position = [a[0], a[1], a[2], a[3]];
		const halfBounds = worldBounds(scene.world);
		for (let axis = 0; axis < 3; axis++) {
			let displacement = b[axis] - a[axis];
			if (
				'boundaries' in scene.world &&
				scene.world.boundaries === 'periodic' &&
				halfBounds[axis] > 0
			) {
				const half = halfBounds[axis];
				displacement %= 2 * half;
				if (displacement > half) displacement -= 2 * half;
				if (displacement < -half) displacement += 2 * half;
				position[axis] += displacement * weight;
				position[axis] = ((((position[axis] + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
			} else position[axis] += displacement * weight;
		}
		if (scene.world.shape === 'sphere') {
			const norm = Math.hypot(position[0], position[1], position[2]);
			if (norm < 1e-8) return weight < 0.5 ? Array.from(a) : Array.from(b);
			for (let axis = 0; axis < 3; axis++) position[axis] *= scene.world.radius / norm;
		}
		if (scene.world.shape === 'plane') position[1] = 0;
		return position;
	};
	agents.forEach((agent, i) => {
		const slot = slots.get(agent.id);
		if (slot === undefined)
			metrics[i * metricStride] = -1; // First measurement initializes temporal fields.
		else {
			state.set(oldState.subarray(slot * 16, slot * 16 + 12), i * 16);
			metrics.set(
				oldMetrics.subarray(slot * metricStride, (slot + 1) * metricStride),
				i * metricStride
			);
		}
		const current = [...state.subarray(i * 16, i * 16 + 3), generation];
		const oldSample = (oldAge: number, color = false) => {
			const source = (previous.head - oldAge + HISTORY_SAMPLES) % HISTORY_SAMPLES;
			const base = color ? oldColorBase : 0;
			return oldHistory.subarray(
				base + (slot! * HISTORY_SAMPLES + source) * 4,
				base + (slot! * HISTORY_SAMPLES + source + 1) * 4
			);
		};
		for (let age = 0; age < HISTORY_SAMPLES; age++) {
			const target = (previous.head - age + HISTORY_SAMPLES) % HISTORY_SAMPLES;
			let sample: ArrayLike<number>;
			if (slot === undefined) sample = current;
			else {
				if (previous.headElapsed === undefined) {
					// Compatibility for callers that did not supply physical sampling phase.
					sample = oldSample(
						Math.min(
							previous.valid - 1,
							Math.round((age * previous.newInterval) / previous.oldInterval)
						)
					);
				} else {
					const targetAge = age * previous.newInterval;
					if (age === 0) sample = current;
					else if (targetAge < previous.headElapsed)
						sample = interpolate(current, oldSample(0), targetAge / previous.headElapsed);
					else {
						const oldAge = Math.min(
							previous.valid - 1,
							(targetAge - previous.headElapsed) / previous.oldInterval
						);
						const younger = Math.floor(oldAge),
							older = Math.min(previous.valid - 1, younger + 1);
						sample = interpolate(oldSample(younger), oldSample(older), oldAge - younger);
					}
				}
			}
			history.set(sample, (i * HISTORY_SAMPLES + target) * 4);
			// Color is sampled with the same physical age as its trajectory. Linear
			// RGB interpolation preserves gradients through population/history edits.
			let color: ArrayLike<number> = [0, 0, 0, 0];
			if (slot !== undefined) {
				const physicalAge = age * previous.newInterval;
				const oldAge = Math.min(
					previous.valid - 1,
					Math.max(0, (physicalAge - (previous.headElapsed ?? 0)) / previous.oldInterval)
				);
				const younger = Math.floor(oldAge),
					older = Math.min(previous.valid - 1, younger + 1);
				const a = oldSample(younger, true),
					b = oldSample(older, true);
				color = Array.from(
					a,
					(value, channel) => value + (b[channel] - value) * (oldAge - younger)
				);
			}
			history.set(color, colorBase + (i * HISTORY_SAMPLES + target) * 4);
		}
	});
	return { particles, metrics, history, valid };
}
