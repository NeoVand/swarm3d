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
		border: 1px solid #d5caee25;
		border-radius: 14px;
		background: #10131cf7;
		color: #eef0f6;
		box-shadow:
			0 24px 100px #0009,
			0 1px 0 #ffffff0a inset;
		backdrop-filter: blur(24px);
		scrollbar-width: thin;
		scrollbar-color: #bca9ff40 transparent;
	}
	.modal.wide {
		width: min(650px, calc(100vw - 28px));
	}
	.modal::backdrop {
		background: #03050a96;
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
		color: #eef0f6;
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.5px;
		line-height: 1.4;
	}
	.modal-header p {
		margin: 4px 0 0;
		color: #9296aa;
		font-size: 11px;
		line-height: 1.5;
	}
	.modal-header button {
		display: grid;
		place-items: center;
		width: 27px;
		height: 27px;
		padding: 0;
		border: 1px solid #ffffff0c;
		border-radius: 7px;
		background: transparent;
		color: #9094a7;
		cursor: pointer;
	}
	.modal-header button:hover {
		color: #eef0f6;
		background: #ffffff08;
	}
	.modal-header button:focus-visible {
		outline: 2px solid #bca9ff;
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
