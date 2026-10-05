<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	let { size = 28, active = true }: { size?: number; active?: boolean } = $props();
	let animated = $derived(active && !prefersReducedMotion.current);
	const trajectory = 'M44 10C26-1 10 12 23 27C31 36 51 24 44 44C35 64 11 59 14 47';
	const segments = [
		[
			[44, 10],
			[26, -1],
			[10, 12],
			[23, 27]
		],
		[
			[23, 27],
			[31, 36],
			[51, 24],
			[44, 44]
		],
		[
			[44, 44],
			[35, 64],
			[11, 59],
			[14, 47]
		]
	];
	const agents = Array.from({ length: 13 }, (_, index) => {
		const progress = (index / 12) * 2.95;
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
		const direction = [0, 1].map(
			(axis) =>
				3 * u ** 2 * (points[1][axis] - points[0][axis]) +
				6 * u * t * (points[2][axis] - points[1][axis]) +
				3 * t ** 2 * (points[3][axis] - points[2][axis])
		);
		return {
			id: index,
			transform: `translate(${point[0]} ${point[1]}) rotate(${(Math.atan2(direction[1], direction[0]) * 180) / Math.PI})`,
			color: index < 5 ? 'var(--aqua)' : index < 9 ? 'var(--lilac)' : 'var(--rose)',
			phase: (index / 13) * -16
		};
	});
</script>

<svg
	class="swarm-logo"
	width={size}
	height={size}
	viewBox="0 0 64 64"
	fill="none"
	aria-hidden="true"
>
	<path d={trajectory} stroke="var(--aqua)" stroke-width=".65" opacity=".12" />
	{#each agents as agent (agent.id)}
		<g transform={animated ? undefined : agent.transform} fill={agent.color}>
			<path d="m3.7 0-7-2.1L-1.6 0l-1.7 2.1Z" />
			<path
				d="M-5.7 0h-3"
				stroke={agent.color}
				stroke-width=".7"
				stroke-linecap="round"
				opacity=".45"
			/>
			{#if animated}
				<animateMotion
					dur="16s"
					begin={`${agent.phase}s`}
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
	}
</style>
