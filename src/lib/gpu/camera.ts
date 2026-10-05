import { perspectiveCamera } from 'vgpu/scene';
import type { CameraDefinition, Vec3, WorldDefinition } from '#lib/model';

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.max(1e-9, Math.hypot(...a)));

/** Isolate roots between derivative extrema, including repeated tangent roots. */
function polynomialRoots(coefficients: number[], lo: number, hi: number): number[] {
	const evaluate = (x: number) => coefficients.reduce((value, c) => value * x + c, 0);
	if (coefficients.length === 2) {
		const root = -coefficients[1] / coefficients[0];
		return root >= lo && root <= hi ? [root] : [];
	}
	const degree = coefficients.length - 1;
	const critical = polynomialRoots(
		coefficients.slice(0, -1).map((c, index) => c * (degree - index)),
		lo,
		hi
	);
	const points = [lo, ...critical, hi];
	const roots: number[] = [];
	const tolerance = coefficients.reduce((sum, c) => sum + Math.abs(c), 0) * 1e-12;
	for (const point of points) if (Math.abs(evaluate(point)) <= tolerance) roots.push(point);
	for (let index = 0; index < points.length - 1; index++) {
		let left = points[index],
			right = points[index + 1];
		let leftValue = evaluate(left);
		if (leftValue * evaluate(right) >= 0) continue;
		for (let step = 0; step < 64; step++) {
			const middle = (left + right) / 2,
				value = evaluate(middle);
			if (value > 0 === leftValue > 0) {
				left = middle;
				leftValue = value;
			} else right = middle;
		}
		roots.push((left + right) / 2);
	}
	return roots.sort((a, b) => a - b);
}

/** The ring-torus implicit quartic, scaled and centered at the closest ray point. */
function pickTorusRay(
	world: Extract<WorldDefinition, { shape: 'torus' }>,
	origin: Vec3,
	direction: Vec3
): { position: Vec3; normal: Vec3 } | null {
	if (Math.hypot(...direction) < 1e-12) return null;
	const ray = normalize(direction),
		bound = world.majorRadius + world.tubeRadius;
	const center = -dot(origin, ray),
		closest = add(origin, scale(ray, center));
	const halfSquared = bound * bound - dot(closest, closest);
	if (halfSquared < 0 || center + Math.sqrt(halfSquared) <= 1e-7) return null;
	const p = scale(closest, 1 / bound),
		R = world.majorRadius / bound,
		r = world.tubeRadius / bound;
	const pd = dot(p, ray),
		e = dot(p, p) + R * R - r * r;
	const coefficients = [
		1,
		4 * pd,
		2 * e + 4 * pd * pd - 4 * R * R * (ray[0] ** 2 + ray[2] ** 2),
		4 * pd * e - 8 * R * R * (p[0] * ray[0] + p[2] * ray[2]),
		e * e - 4 * R * R * (p[0] ** 2 + p[2] ** 2)
	];
	const half = Math.sqrt(halfSquared) / bound;
	for (const root of polynomialRoots(coefficients, -half, half)) {
		const distance = center + root * bound;
		if (distance <= 1e-7) continue;
		const position = add(origin, scale(ray, distance));
		const azimuth = Math.hypot(position[0], position[2]);
		const tubeCenter: Vec3 = [
			(world.majorRadius * position[0]) / azimuth,
			0,
			(world.majorRadius * position[2]) / azimuth
		];
		return { position, normal: normalize(add(position, scale(tubeCenter, -1))) };
	}
	return null;
}

/** Intersect the physical visible surface, not its containing box or closed end caps. */
export function pickWorldRay(
	world: WorldDefinition,
	origin: Vec3,
	direction: Vec3,
	workNormal: Vec3 = [0, 1, 0],
	depth = 0
): { position: Vec3; normal: Vec3 | null } | null {
	if (world.shape === 'torus') return pickTorusRay(world, origin, direction);
	if (world.shape === 'sphere' || world.shape === 'cylinder') {
		const cylinder = world.shape === 'cylinder';
		const radialOrigin: Vec3 = cylinder ? [origin[0], 0, origin[2]] : origin;
		const radialDirection: Vec3 = cylinder ? [direction[0], 0, direction[2]] : direction;
		const a = dot(radialDirection, radialDirection);
		if (a < 1e-12) return null;
		const b = dot(radialOrigin, radialDirection);
		const c = dot(radialOrigin, radialOrigin) - world.radius ** 2;
		const discriminant = b * b - a * c;
		if (discriminant < 0) return null;
		const root = Math.sqrt(discriminant);
		for (const t of [(-b - root) / a, (-b + root) / a]) {
			if (t <= 1e-7) continue;
			const position = add(origin, scale(direction, t));
			if (world.shape === 'cylinder' && Math.abs(position[1]) > world.halfHeight + 1e-7) continue;
			return {
				position,
				normal: normalize(cylinder ? [position[0], 0, position[2]] : position)
			};
		}
		return null;
	}
	const normal: Vec3 = world.shape === 'plane' ? [0, 1, 0] : workNormal;
	const offset = world.shape === 'plane' ? 0 : depth;
	const denominator = dot(direction, normal);
	if (Math.abs(denominator) < 1e-8) return null;
	const t = (offset - dot(origin, normal)) / denominator;
	if (t <= 1e-7) return null;
	const position = add(origin, scale(direction, t));
	if (world.shape === 'plane') {
		if (
			Math.abs(position[0]) > world.halfExtents[0] ||
			Math.abs(position[2]) > world.halfExtents[1]
		)
			return null;
		return { position: [position[0], 0, position[2]], normal };
	}
	if (position.some((v, i) => Math.abs(v) > world.halfExtents[i])) return null;
	return { position, normal: null };
}

export class StageCamera {
	definition: CameraDefinition;
	readonly camera = perspectiveCamera({ fov: 42, near: 0.05, far: 1000 });
	position: Vec3 = [0, 0, 1];
	right: Vec3 = [1, 0, 0];
	up: Vec3 = [0, 1, 0];
	forward: Vec3 = [0, 0, -1];
	aspect = 1;
	constructor(definition: CameraDefinition) {
		this.definition = structuredClone(definition);
	}
	update(aspect: number, elapsed = 0) {
		this.aspect = aspect;
		this.definition.yaw += elapsed * this.definition.autoRotate;
		const { yaw, pitch, distance, target } = this.definition;
		this.position = add(target, [
			distance * Math.sin(yaw) * Math.cos(pitch),
			distance * Math.sin(pitch),
			distance * Math.cos(yaw) * Math.cos(pitch)
		]);
		this.forward = normalize(add(target, scale(this.position, -1)));
		this.right = normalize(cross(this.forward, [0, 1, 0]));
		this.up = cross(this.right, this.forward);
		this.camera
			.set({ aspect, position: this.position, far: Math.max(1000, distance * 10) })
			.lookAt(target);
		return this.camera.viewProjection;
	}
	orbit(dx: number, dy: number) {
		this.definition.yaw -= dx * 0.006;
		this.definition.pitch = Math.max(-1.48, Math.min(1.48, this.definition.pitch + dy * 0.006));
	}
	pan(dx: number, dy: number, height: number) {
		const amount = (this.definition.distance * 2 * Math.tan((21 * Math.PI) / 180)) / height;
		this.definition.target = add(
			this.definition.target,
			add(scale(this.right, -dx * amount), scale(this.up, dy * amount))
		);
	}
	zoom(delta: number) {
		this.definition.distance = Math.max(
			1,
			Math.min(100000, this.definition.distance * Math.exp(delta * 0.001))
		);
	}
	ray(x: number, y: number): { origin: Vec3; direction: Vec3 } {
		const tan = Math.tan((21 * Math.PI) / 180);
		return {
			origin: this.position,
			direction: normalize(
				add(this.forward, add(scale(this.right, x * this.aspect * tan), scale(this.up, y * tan)))
			)
		};
	}
	project(point: Vec3): Vec3 {
		const m = this.camera.viewProjection;
		const x = point[0],
			y = point[1],
			z = point[2];
		const w = m[3] * x + m[7] * y + m[11] * z + m[15];
		return [
			(m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
			(m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
			(m[2] * x + m[6] * y + m[10] * z + m[14]) / w
		];
	}
	hit(
		x: number,
		y: number,
		world: WorldDefinition,
		normal: Vec3,
		depth: number
	): { position: Vec3; normal: Vec3 | null } | null {
		const { origin, direction } = this.ray(x, y);
		return pickWorldRay(world, origin, direction, normal, depth);
	}
}
