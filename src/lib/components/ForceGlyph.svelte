<script lang="ts">
	let {
		type,
		active = false,
		size = 24,
		direction = 1
	}: {
		type: 'attract' | 'repel' | 'vortex' | 'ignore';
		active?: boolean;
		size?: number;
		direction?: number;
	} = $props();
	const spokes = [0, 60, 120, 180, 240, 300];
</script>

<svg
	class="force-glyph"
	class:active
	class:reverse={direction < 0}
	class:outward={type === 'repel'}
	class:swirl={type === 'vortex'}
	width={size}
	height={size}
	viewBox="0 0 32 32"
	fill="none"
	aria-hidden="true"
	style:--force-color={type === 'attract'
		? '#67d7de'
		: type === 'repel'
			? '#f798af'
			: type === 'vortex'
				? '#baa1ed'
				: '#89929d'}
>
	{#if type === 'ignore'}
		<circle cx="16" cy="16" r="9" stroke="currentColor" stroke-width="1" opacity="0.5" /><path
			d="m10 22 12-12"
			stroke="currentColor"
			stroke-width="1.2"
		/>
	{:else if type === 'vortex'}
		<g class="vortex" stroke="currentColor" stroke-linecap="round">
			{#each [0, 120, 240] as angle (angle)}<g transform={`rotate(${angle} 16 16)`}
					><path d="M16 16c-8 2-11-6-7-10" stroke-width="1.3" /><path
						d="M16 16c-8 4-15-1-14-6"
						stroke-width="1"
						opacity="0.2"
					/></g
				>{/each}
		</g><circle cx="16" cy="16" r="1.5" fill="currentColor" />
	{:else}
		{#each spokes as angle (angle)}<g transform={`rotate(${angle} 16 16)`}
				><g class="particle"
					><path
						d={type === 'attract' ? 'm16 10-2-4h4Z' : 'm16 3 2 4h-4Z'}
						fill="currentColor"
					/><path d="M16 2v2" stroke="currentColor" opacity="0.3" /></g
				></g
			>{/each}
		<circle cx="16" cy="16" r="2" fill="currentColor" opacity="0.65" />
	{/if}
</svg>

<style>
	.force-glyph {
		display: block;
		color: var(--force-color);
		opacity: 0.55;
		transition: opacity 180ms ease;
	}
	.active,
	:global(button:hover) .force-glyph {
		opacity: 1;
	}
	.particle {
		transform-origin: 16px 16px;
		animation: inward 2.4s ease-in-out infinite;
		animation-play-state: paused;
	}
	.active .particle,
	:global(button:hover) .particle {
		animation-play-state: running;
	}
	.outward .particle {
		animation-name: outward;
	}
	.vortex {
		transform-origin: 16px 16px;
		animation: spin 5s linear infinite;
		animation-play-state: paused;
	}
	.active .vortex,
	:global(button:hover) .vortex {
		animation-play-state: running;
	}
	.reverse .vortex {
		animation-direction: reverse;
	}
	@keyframes inward {
		0% {
			transform: translateY(-2px);
			opacity: 0.1;
		}
		40% {
			opacity: 1;
		}
		100% {
			transform: translateY(5px);
			opacity: 0.1;
		}
	}
	@keyframes outward {
		0% {
			transform: translateY(6px);
			opacity: 0.1;
		}
		40% {
			opacity: 1;
		}
		100% {
			transform: translateY(-2px);
			opacity: 0.1;
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.particle,
		.vortex {
			animation: none;
		}
		.force-glyph {
			transition: none;
		}
	}
</style>
