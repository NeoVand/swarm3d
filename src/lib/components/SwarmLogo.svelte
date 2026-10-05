<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	let { size = 28, active = true }: { size?: number; active?: boolean } = $props();
	let animated = $derived(!prefersReducedMotion.current);
	// The two lobes meet with the same tangent. Every bird completes a closed
	// trajectory, so a new cycle has neither a position nor an orientation jump.
	const trajectory = 'M32 32C9 16 9 8 25 8C46 8 57 17 32 32C7 47 18 56 39 56C55 56 55 48 32 32Z';
	const segments = [
		[
			[32, 32],
			[9, 16],
			[9, 8],
			[25, 8]
		],
		[
			[25, 8],
			[46, 8],
			[57, 17],
			[32, 32]
		],
		[
			[32, 32],
			[7, 47],
			[18, 56],
			[39, 56]
		],
		[
			[39, 56],
			[55, 56],
			[55, 48],
			[32, 32]
		]
	];
	const birds = Array.from({ length: 6 }, (_, index) => {
		const progress = (index / 6) * segments.length;
		const points = segments[Math.floor(progress)];
		const t = progress % 1,
			u = 1 - t;
		const point = [0, 1].map(
			(axis) =>
				u ** 3 * points[0][axis] +
				3 * u ** 2 * t * points[1][axis] +
				3 * u * t ** 2 * points[2][axis] +
				t ** 3 * points[3][axis]
		);
		const tangent = [0, 1].map(
			(axis) =>
				3 * u ** 2 * (points[1][axis] - points[0][axis]) +
				6 * u * t * (points[2][axis] - points[1][axis]) +
				3 * t ** 2 * (points[3][axis] - points[2][axis])
		);
		return {
			id: index,
			pose: `translate(${point[0]} ${point[1]}) rotate(${(Math.atan2(tangent[1], tangent[0]) * 180) / Math.PI})`,
			color: index < 2 ? 'var(--aqua)' : index < 4 ? 'var(--lilac)' : 'var(--rose)',
			phase: -index * 2,
			scale: index % 2 === 0 ? 1.18 : 0.88
		};
	});
</script>

<svg
	class="swarm-logo"
	class:active
	width={size}
	height={size}
	viewBox="0 0 64 64"
	fill="none"
	aria-hidden="true"
>
	<path class="wake" d={trajectory} />
	{#each birds as bird (bird.id)}
		<g data-logo-agent={bird.id} transform={animated ? undefined : bird.pose}>
			<g fill={bird.color} transform={`scale(${bird.scale})`}>
				<path d="M7 0-6.5-4.2-2.2 0-6.5 4.2Z" />
				<path
					d="M-8 0h-4"
					stroke={bird.color}
					stroke-width="1.2"
					stroke-linecap="round"
					opacity=".38"
				/>
			</g>
			{#if animated}
				<animateMotion
					dur="12s"
					begin={`${bird.phase}s`}
					repeatCount="indefinite"
					rotate="auto"
					path={trajectory}
				/>
			{/if}
		</g>
	{/each}
</svg>

<style>
	.swarm-logo {
		display: block;
		flex: none;
		overflow: visible;
		opacity: 0.84;
		transition: opacity 250ms ease;
	}
	.active {
		opacity: 1;
	}
	.wake {
		stroke: var(--ink);
		stroke-width: 0.8;
		stroke-opacity: 0.055;
	}
	@media (prefers-reduced-motion: reduce) {
		.swarm-logo {
			transition: none;
		}
	}
</style>
