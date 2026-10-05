<script lang="ts">
	let { kind }: { kind: 'volume' | 'surface' } = $props();
	const volume = [
		[23, 21, -20],
		[39, 19, 45],
		[47, 29, 15],
		[19, 35, 65],
		[31, 30, -40],
		[41, 41, 120],
		[30, 47, 40],
		[20, 46, -15],
		[44, 51, 165]
	];
	const surface = [
		[21, 13, -28],
		[40, 13, 28],
		[51, 29, 70],
		[45, 49, 132],
		[28, 53, 165],
		[12, 39, -110],
		[12, 24, -55],
		[31, 31, 20]
	];
	let agents = $derived(kind === 'volume' ? volume : surface);
</script>

<svg class="domain-glyph" viewBox="0 0 64 64" fill="none" aria-hidden="true">
	{#if kind === 'volume'}
		<path class="shell" d="m10 19 23-11 23 13v28L33 59 10 46Z" />
		<path class="hidden" d="M33 8v28L10 46m23-10 23 13" />
		<path class="shell" d="m10 19 23 14 23-12M33 33v26" />
	{:else}
		<circle class="shell" cx="32" cy="32" r="23" />
		<ellipse class="hidden" cx="32" cy="32" rx="10" ry="23" transform="rotate(-24 32 32)" />
		<ellipse class="shell" cx="32" cy="32" rx="23" ry="8" transform="rotate(-24 32 32)" />
	{/if}
	{#each agents as agent, index (agent.join(','))}
		<path
			class="agent"
			d="m0-3 2.1 5-2.1-1.1L-2.1 2Z"
			transform={`translate(${agent[0]} ${agent[1]}) rotate(${agent[2]})`}
			style:--agent-opacity={index % 3 === 0 ? 1 : 0.65}
		/>
	{/each}
</svg>

<style>
	.domain-glyph {
		width: 42px;
		height: 42px;
		flex: none;
		overflow: visible;
	}
	.shell {
		stroke: var(--world-accent, var(--aqua));
		stroke-width: 1;
		stroke-opacity: 0.5;
		fill: var(--world-accent, var(--aqua));
		fill-opacity: 0.035;
	}
	.hidden {
		stroke: var(--world-accent, var(--aqua));
		stroke-width: 0.8;
		stroke-opacity: 0.2;
		stroke-dasharray: 2 2;
	}
	.agent {
		fill: var(--world-accent, var(--aqua));
		opacity: var(--agent-opacity);
	}
</style>
