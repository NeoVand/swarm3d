import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { init, effect, frame, sampler, target } from 'vgpu/node';

// Isolate the production bloom chain with ordinary, sub-threshold agent colors.
const require = createRequire(import.meta.url);
const { resolveShader } = await import(
	pathToFileURL(
		require.resolve('@vgpu/wgsl/runtime', {
			paths: [dirname(require.resolve('vgpu'))]
		})
	).href
);
const shaders = Object.fromEntries(
	await Promise.all(
		['highlights', 'bloom', 'presentation'].map(async (name) => [
			name,
			(await resolveShader({ entry: resolve(`src/lib/gpu/shaders/${name}.wgsl`) })).wgsl
		])
	)
);
const gpu = await init();
const errors = [];
gpu.onError((error) => errors.push(String(error)));
gpu.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const stage = target(gpu, { size: [256, 192], format: 'rgba16float' });
const bright = target(gpu, { size: [64, 48], format: 'rgba16float' });
const glow = target(gpu, { size: [64, 48], format: 'rgba16float' });
const output = target(gpu, { size: stage.size, format: 'rgba8unorm' });
const imageSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
const source = effect(
	gpu,
	`
struct Fixture { background: vec3f, color: vec3f, offset: f32, radius: f32 }
@group(0) @binding(0) var<uniform> fixture: Fixture;
@fragment fn fs_main(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let distance=length(pixel.xy-vec2f(128.0+fixture.offset,96.0));
  let coverage=1.0-smoothstep(fixture.radius-0.5,fixture.radius+0.5,distance);
  return vec4f(mix(fixture.background,fixture.color,coverage),1.0);
}`,
	{ set: { fixture: { background: [0, 0, 0], color: [0.1, 0.3, 0.15], offset: 0, radius: 3 } } }
);
const extract = effect(gpu, shaders.highlights, {
	set: {
		image: stage,
		imageSampler,
		glow: { texel: stage.texelSize, background: [0, 0, 0], day: 0 }
	}
});
const blur = effect(gpu, shaders.bloom, {
	set: { image: bright, imageSampler, glow: { texel: bright.texelSize } }
});
const present = effect(gpu, shaders.presentation, {
	set: { image: stage, imageSampler, glow, presentation: { bloom: 0, exposure: 1, day: 0 } }
});
await Promise.all([
	source.compile(stage),
	extract.compile(bright),
	blur.compile(glow),
	present.compile(output)
]);
const render = async (background, color, day, bloom, offset = 0, radius = 3) => {
	source.set({ fixture: { background, color, offset, radius } });
	extract.set({ glow: { texel: stage.texelSize, background, day } });
	present.set({ presentation: { bloom, exposure: 1, day } });
	const submitted = frame(gpu, (f) => {
		f.pass(stage, source);
		if (bloom) {
			f.pass(bright, extract);
			f.pass(glow, blur);
		}
		f.pass(output, present);
	});
	await submitted.done;
	await gpu.gpu.queue.onSubmittedWorkDone();
	return output.color.read({ mipLevel: 0, region: 'all' });
};
try {
	for (const [day, background] of [
		[0, [0.002, 0.004, 0.006]],
		[0, [0.12, 0.08, 0.04]],
		[1, [0.8, 0.86, 0.9]]
	]) {
		for (const color of [
			[0.06, 0.32, 0.16],
			[0.5, 0.08, 0.04],
			[0.18, 0.18, 0.18]
		]) {
			const off = await render(background, color, day, 0);
			const on = await render(background, color, day, 1);
			let halo = 0,
				center = 0;
			for (let y = 72; y < 120; y++)
				for (let x = 104; x < 152; x++) {
					const index = (y * 256 + x) * 4;
					const change = [0, 1, 2].reduce(
						(sum, c) => sum + Math.abs(on[index + c] - off[index + c]),
						0
					);
					if (Math.hypot(x + 0.5 - 128, y + 0.5 - 96) > 5) halo += change;
					else center += change;
				}
			assert.ok(halo > 120, `visible halo around ordinary ${day ? 'day' : 'night'} body (${halo})`);
			assert.ok(center > 0, 'bloom switch changes the actual stage');
			assert.deepEqual(on.slice(0, 4), off.slice(0, 4), 'remote background is untouched');
		}
		const off = await render(background, background, day, 0);
		assert.deepEqual(
			await render(background, background, day, 1),
			off,
			'uniform selected background never blooms'
		);
	}
	const energies = [];
	for (const offset of [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5]) {
		await render([0, 0, 0], [0.06, 0.32, 0.16], 0, 1, offset, 1.5);
		const pixels = await glow.color.readFloats({ mipLevel: 0, region: 'all' });
		energies.push(pixels.reduce((sum, value, index) => sum + (index % 4 === 3 ? 0 : value), 0));
	}
	assert.ok(Math.min(...energies) > 0.02, 'tiny moving agents never lose all bloom energy');
	assert.ok(
		Math.max(...energies) / Math.min(...energies) < 1.6,
		'subpixel shifts retain smoothly area-filtered glow'
	);
	await gpu.settled();
	assert.deepEqual(errors, []);
	console.log(
		'PASS bloom visibly affects ordinary colored/gray bodies in day/night, preserves every flat background, and retains tiny moving highlights'
	);
} finally {
	await gpu.gpu.queue.onSubmittedWorkDone();
	await gpu.dispose();
}
