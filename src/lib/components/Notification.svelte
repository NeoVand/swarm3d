<script lang="ts">
	import Icon from './Icon.svelte';
	let {
		toast,
		onclose,
		inline = false
	}: {
		toast: { message: string; action?: string; run?: () => void };
		onclose: () => void;
		inline?: boolean;
	} = $props();
	function reveal(element: HTMLElement) {
		if (inline && toast.message) element.scrollIntoView({ block: 'nearest' });
	}
</script>

<div {@attach reveal} class="glass" class:toast={!inline} class:inline-toast={inline} role="status">
	<span>{toast.message}</span>{#if toast.action}<button onclick={() => toast.run?.()}
			>{toast.action}</button
		>{/if}<button class="icon-button compact" aria-label="Dismiss notification" onclick={onclose}
		><Icon name="close" size={14} /></button
	>
</div>
