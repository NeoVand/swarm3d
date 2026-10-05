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
		const active = document.activeElement;
		const opener = active instanceof HTMLElement && active.getClientRects().length ? active : null;
		element.showModal();
		return () => {
			element.close();
			queueMicrotask(() => {
				if (
					!opener?.isConnected ||
					!opener.getClientRects().length ||
					opener.matches(':disabled') ||
					opener.closest('[inert]')
				)
					return;
				if (document.querySelector('dialog[open]')) return;
				const focus = document.activeElement;
				if (
					focus instanceof HTMLElement &&
					focus.closest('[popover]:popover-open') &&
					!element.contains(focus)
				)
					return;
				const visibility = getComputedStyle(opener).visibility;
				if (visibility === 'hidden' || visibility === 'collapse') return;
				opener.focus({ preventScroll: true });
			});
		};
	}
	function dismissBackdrop(event: PointerEvent) {
		if (event.target !== event.currentTarget) return;
		const rect = (event.currentTarget as HTMLDialogElement).getBoundingClientRect();
		if (
			event.clientX < rect.left ||
			event.clientX > rect.right ||
			event.clientY < rect.top ||
			event.clientY > rect.bottom
		)
			onclose();
	}
</script>

<dialog
	{@attach modal}
	class="modal"
	class:wide
	aria-labelledby={uid}
	onpointerdown={dismissBackdrop}
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

<style>
	.modal {
		box-sizing: border-box;
		width: min(430px, calc(100vw - 28px));
		max-height: calc(100dvh - 36px);
		margin: auto;
		padding: 17px;
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--panel);
		color: var(--pearl);
		box-shadow:
			0 24px 100px var(--shadow),
			0 1px 0 color-mix(in srgb, var(--ink) 4%, transparent) inset;
		-webkit-backdrop-filter: blur(24px) saturate(1.1);
		backdrop-filter: blur(24px) saturate(1.1);
		scrollbar-width: thin;
		scrollbar-color: color-mix(in srgb, var(--lilac) 25%, transparent) transparent;
	}
	.modal.wide {
		width: min(650px, calc(100vw - 28px));
	}
	.modal::backdrop {
		background: color-mix(in srgb, var(--shadow) 65%, transparent);
		backdrop-filter: blur(7px);
	}
	.modal-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 16px;
	}
	.modal-header h2 {
		margin: 0;
		color: var(--pearl);
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.5px;
		line-height: 1.4;
	}
	.modal-header p {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.5;
	}
	.modal-header button {
		display: grid;
		place-items: center;
		width: 27px;
		height: 27px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: transparent;
		color: var(--faint);
		cursor: pointer;
	}
	.modal-header button:hover {
		color: var(--pearl);
		background: color-mix(in srgb, var(--ink) 3%, transparent);
	}
	.modal-header button:focus-visible {
		outline: 2px solid var(--lilac);
		outline-offset: 2px;
	}
	@media (max-width: 540px) {
		.modal,
		.modal.wide {
			padding: 14px;
			max-height: calc(100dvh - 24px);
		}
	}
</style>
