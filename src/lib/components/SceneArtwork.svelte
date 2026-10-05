<script lang="ts">
	import { PALETTES, type SceneDefinition } from '#lib/model';
	let { scene, thumbnail }: { scene: SceneDefinition; thumbnail?: string } = $props();
	const uid = $props.id();
	let hue = $derived(scene.species[0]?.visual.hsl[0] ?? 0.5);
	let marks = $derived.by(() => {
		const random = (index: number) => {
			const n = Math.sin(index * 127.1 + scene.seed * 0.0137) * 43758.5453;
			return n - Math.floor(n);
		};
		const palette = PALETTES.find((item) => item.id === scene.visual.palette);
		return Array.from({ length: 110 }, (_, index) => {
			const t = random(index + 1) * Math.PI * 2;
			const spread = random(index + 130);
			let x: number, y: number, angle: number, depth: number;
			if (scene.world.shape === 'sphere') {
				const latitude = Math.asin(spread * 2 - 1);
				const radius = scene.world.kind === 'volume' ? Math.cbrt(random(index + 740)) : 1;
				const px = Math.cos(t) * Math.cos(latitude) * radius,
					pz = Math.sin(t) * Math.cos(latitude) * radius;
				x = 110 + px * 66;
				y = 63 + (Math.sin(latitude) * radius * 0.88 - pz * 0.36) * 55;
				angle = Math.atan2(Math.cos(t) * -0.35, -Math.sin(t));
				depth = pz * 0.88 + Math.sin(latitude) * radius * 0.36;
			} else if (scene.world.shape === 'torus') {
				const tube = random(index + 310) * Math.PI * 2;
				const ratio = Math.min(0.6, scene.world.tubeRadius / scene.world.majorRadius);
				const filling = scene.world.kind === 'volume' ? Math.sqrt(random(index + 740)) : 1;
				const r = 52 + Math.cos(tube) * filling * ratio * 52;
				x = 110 + Math.cos(t) * r * 1.35;
				y = 63 + Math.sin(t) * r * 0.53 + Math.sin(tube) * filling * ratio * 35;
				angle = Math.atan2(Math.cos(t) * 0.53, -Math.sin(t) * 1.35);
				depth = Math.sin(t);
			} else if (scene.world.shape === 'cylinder') {
				const filling = scene.world.kind === 'volume' ? Math.sqrt(random(index + 740)) : 1;
				x = 110 + Math.cos(t) * filling * 48;
				y = 20 + spread * 76 + Math.sin(t) * filling * 12;
				angle = Math.atan2(Math.cos(t) * 0.25, -Math.sin(t));
				depth = Math.sin(t) * filling;
			} else {
				const wave = scene.id.includes('cross') ? index % 2 : 0;
				x = 9 + random(index + 440) * 202;
				const arc = (x - 110) / 75;
				y =
					63 +
					Math.sin(arc + wave * Math.PI) * 24 +
					(spread - 0.5) * (scene.id.includes('murmuration') ? 20 : 48);
				angle = Math.atan(Math.cos(arc + wave * Math.PI) * 0.4) + wave * Math.PI;
				depth = spread * 2 - 1;
			}
			const species = scene.species[index % scene.species.length];
			const [h, s, l] = species.visual.hsl;
			const mapping = species.visual.hue;
			const mappedColor = palette?.colors[Math.floor(spread * palette.colors.length)];
			const color =
				mapping.enabled && mapping.source !== 'constant' && mappedColor
					? mappedColor
					: `hsl(${h * 360} ${s * 100}% ${Math.min(78, l * 100 + 10)}%)`;
			const length = Math.min(16, 3 + species.trail.length * (3 + random(index + 605) * 5));
			return {
				id: index,
				x,
				y,
				angle: (angle * 180) / Math.PI,
				color,
				opacity: 0.25 + (depth + 1) * 0.33,
				path: `M${x - Math.cos(angle) * length} ${y - Math.sin(angle) * length} Q${x - Math.cos(angle) * length * 0.5} ${y - Math.sin(angle) * length * 0.5 - 1.5} ${x} ${y}`
			};
		}).sort((a, b) => a.opacity - b.opacity);
	});
</script>

<div class="scene-artwork" aria-hidden="true">
	{#if thumbnail}<img src={thumbnail} alt="" loading="lazy" />{:else}
		<svg viewBox="0 0 220 126" fill="none">
			<defs
				><radialGradient id={`${uid}-wash`}
					><stop stop-color={`hsl(${hue * 360} 35% 23%)`} stop-opacity=".4" /><stop
						offset="1"
						stop-color={scene.visual.background}
						stop-opacity="0"
					/></radialGradient
				></defs
			>
			<rect width="220" height="126" fill={scene.visual.background} /><ellipse
				cx="110"
				cy="63"
				rx="130"
				ry="82"
				fill={`url(#${uid}-wash)`}
			/>
			{#if scene.world.shape === 'sphere'}<circle
					cx="110"
					cy="63"
					r="62"
					fill="#bbcaff03"
					stroke="#c8d8ff0c"
				/><ellipse
					cx="110"
					cy="63"
					rx="66"
					ry="22"
					stroke="#c8d8ff0b"
					transform="rotate(-15 110 63)"
				/>{:else if scene.world.shape === 'torus'}<ellipse
					cx="110"
					cy="63"
					rx="83"
					ry="36"
					stroke="#c8d8ff0b"
				/><ellipse cx="110" cy="63" rx="42" ry="17" stroke="#c8d8ff0b" />{/if}
			{#each marks as mark (mark.id)}
				<g opacity={mark.opacity}
					><path
						d={mark.path}
						stroke={mark.color}
						stroke-width=".7"
						stroke-linecap="round"
						opacity=".38"
					/><path
						d="m2 0-3-1.15.7 1.15-.7 1.15Z"
						transform={`translate(${mark.x} ${mark.y}) rotate(${mark.angle})`}
						fill={mark.color}
					/></g
				>
			{/each}
		</svg>
	{/if}
</div>

<style>
	.scene-artwork {
		aspect-ratio: 220 / 126;
		overflow: hidden;
		background: #0b0f18;
	}
	svg,
	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	svg {
		transition: transform 0.45s ease;
	}
	.scene-artwork:hover svg {
		transform: scale(1.025);
	}
	@media (prefers-reduced-motion: reduce) {
		svg {
			transition: none;
		}
	}
</style>
