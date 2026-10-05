<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	let {
		title,
		subtitle = '',
		onclose,
		children,
		notice,
		wide = false
	}: {
		title: string;
		subtitle?: string;
		onclose: () => void;
		children: Snippet;
		notice?: Snippet;
		wide?: boolean;
	} = $props();
	const uid = $props.id();
	function modal(element: HTMLDialogElement) {
		element.showModal();
		return () => element.close();
	}
</script>

<dialog
	{@attach modal}
	class="modal"
	class:wide
	aria-labelledby={uid}
	oncancel={(event) => {
		event.preventDefault();
		onclose();
	}}
>
	<header class="modal-header">
		<div>
			<h2 id={uid}>{title}</h2>
			{#if subtitle}<p>{subtitle}</p>{/if}
		</div>
		<button class="icon-button" aria-label="Close dialog" onclick={onclose}
			><Icon name="close" /></button
		>
	</header>
	{@render children()}
	{@render notice?.()}
</dialog>
