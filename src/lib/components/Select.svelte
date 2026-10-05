<script lang="ts">
	import { tick } from 'svelte';
	import ChoiceArtwork from './ChoiceArtwork.svelte';
	import Icon from './Icon.svelte';
	let {
		value,
		options,
		label,
		onchange,
		disabled = false,
		size = 'normal',
		placeholder = 'Choose…',
		id,
		describedby
	}: {
		value: string;
		options: {
			value: string;
			label: string;
			description?: string;
			group?: string;
			color?: string;
			icon?: string;
		}[];
		label: string;
		onchange: (value: string) => void;
		disabled?: boolean;
		size?: 'normal' | 'compact';
		placeholder?: string;
		id?: string;
		describedby?: string;
	} = $props();
	const uid = $props.id();
	let open = $state(false);
	let active = $state(0);
	let position = $state({ left: 0, top: 0, width: 220, maxHeight: 320 });
	let trigger: HTMLButtonElement;
	let menu: HTMLDivElement;
	let selected = $derived(options.find((option) => option.value === value));
	let hasDescriptions = $derived(options.some((option) => option.description));
	let search = '';
	let lastKey = 0;

	function place() {
		if (!trigger || !menu) return true;
		const rect = trigger.getBoundingClientRect();
		const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
		const below = window.innerHeight - rect.bottom - 16;
		const above = rect.top - 16;
		const useBelow = below >= Math.min(260, above);
		const height = Math.min(340, useBelow ? below : above);
		position = {
			left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
			top: useBelow
				? rect.bottom + 6
				: Math.max(12, rect.top - Math.min(menu.scrollHeight, height) - 6),
			width,
			maxHeight: Math.max(0, height)
		};
		return useBelow;
	}
	function close(restoreFocus = true) {
		if (!open) return;
		open = false;
		menu?.hidePopover();
		if (restoreFocus) trigger?.focus({ preventScroll: true });
	}
	async function show(
		index = Math.max(
			0,
			options.findIndex((option) => option.value === value)
		),
		typed = false
	) {
		if (disabled || !options.length) return;
		active = index;
		open = true;
		if (!typed) search = '';
		await tick();
		if (!open || !menu.isConnected || disabled || !options.length) {
			open = false;
			return;
		}
		menu.showPopover();
		const useBelow = place();
		await tick();
		if (!useBelow)
			position = {
				...position,
				top: Math.max(12, trigger.getBoundingClientRect().top - menu.offsetHeight - 6)
			};
		menu.focus({ preventScroll: true });
		menu
			.querySelector(`#${CSS.escape(`${uid}-option-${active}`)}`)
			?.scrollIntoView({ block: 'nearest' });
	}
	function choose(index: number) {
		const option = options[index];
		if (!option) return;
		onchange(option.value);
		close();
	}
	async function move(index: number) {
		active = Math.max(0, Math.min(options.length - 1, index));
		await tick();
		menu
			?.querySelector(`#${CSS.escape(`${uid}-option-${active}`)}`)
			?.scrollIntoView({ block: 'nearest' });
	}
	function keyboard(event: KeyboardEvent) {
		if (disabled) return;
		if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === 'Escape') {
				close();
				return;
			}
			if (!open) {
				void show(event.key === 'End' ? options.length - 1 : undefined);
				return;
			}
			if (event.key === 'Enter' || event.key === ' ') {
				choose(active);
				return;
			}
			void move(
				event.key === 'Home'
					? 0
					: event.key === 'End'
						? options.length - 1
						: active + (event.key === 'ArrowDown' ? 1 : -1)
			);
		} else if (event.key === 'Tab') {
			close();
		} else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.stopPropagation();
			const now = Date.now();
			search = now - lastKey < 650 ? search + event.key.toLowerCase() : event.key.toLowerCase();
			lastKey = now;
			const repeated = [...search].every((character) => character === event.key.toLowerCase());
			const needle = repeated ? event.key.toLowerCase() : search;
			const offset = repeated && open ? active + 1 : 0;
			let match = -1;
			for (let i = 0; i < options.length; i++) {
				const index = (offset + i) % options.length;
				if (options[index].label.toLowerCase().startsWith(needle)) {
					match = index;
					break;
				}
			}
			if (match >= 0) {
				if (!open) void show(match, true);
				else void move(match);
			}
		}
	}
	function dismiss(event: PointerEvent) {
		const target = event.target;
		if (open && target instanceof Node && !menu?.contains(target) && !trigger?.contains(target))
			close(false);
	}
	function trackMenu(unavailable: boolean) {
		return (element: HTMLDivElement) => {
			menu = element;
			if (unavailable && element.matches(':popover-open')) element.hidePopover();
			const scroll = (event: Event) => {
				if (open && event.target instanceof Node && !element.contains(event.target)) close();
			};
			document.addEventListener('scroll', scroll, true);
			return () => {
				document.removeEventListener('scroll', scroll, true);
				if (element.matches(':popover-open')) element.hidePopover();
			};
		};
	}
	function trackTrigger(element: HTMLButtonElement) {
		trigger = element;
	}
</script>

<svelte:document onpointerdown={dismiss} />
<svelte:window onresize={() => close()} />

<button
	type="button"
	class="select-trigger"
	class:compact={size === 'compact'}
	class:expanded={open}
	{@attach trackTrigger}
	{id}
	{disabled}
	aria-label={label}
	aria-describedby={describedby}
	role="combobox"
	aria-autocomplete="none"
	aria-haspopup="listbox"
	aria-expanded={open}
	aria-controls={`${uid}-list`}
	data-value={value}
	onclick={() => (open ? close() : void show())}
	onkeydown={keyboard}
>
	{#if selected?.icon}<span
			class="choice-symbol"
			style:color={selected.color ?? 'var(--accent, #bca9ff)'}
			><ChoiceArtwork name={selected.icon} size={19} /></span
		>{:else if selected?.color}<span class="choice-dot" style:background={selected.color}
		></span>{/if}
	<span class="select-value">{selected?.label ?? placeholder}</span><span class="select-chevron"
		><Icon name="down" size={12} /></span
	>
</button>
<div
	{@attach trackMenu(disabled || !options.length)}
	popover="manual"
	id={`${uid}-list`}
	class="select-menu"
	role="listbox"
	tabindex="-1"
	aria-label={label}
	aria-activedescendant={open ? `${uid}-option-${active}` : undefined}
	aria-describedby={hasDescriptions ? `${uid}-description` : undefined}
	onbeforetoggle={(event) => {
		if (event.newState === 'closed') open = false;
	}}
	style:left={`${position.left}px`}
	style:top={`${position.top}px`}
	style:width={`${position.width}px`}
	style:max-height={`${position.maxHeight}px`}
	onkeydown={keyboard}
>
	<div class="option-list" role="presentation">
		{#each options as option, index (option.value)}
			{#if option.group && (index === 0 || options[index - 1].group !== option.group)}<div
					class="option-group"
					aria-hidden="true"
				>
					{option.group}
				</div>{/if}
			<div
				role="option"
				id={`${uid}-option-${index}`}
				aria-selected={value === option.value}
				aria-describedby={active === index && option.description ? `${uid}-description` : undefined}
				data-value={option.value}
				tabindex="-1"
				onkeydown={keyboard}
				class="select-option"
				class:highlighted={active === index}
				class:chosen={value === option.value}
				onpointermove={() => (active = index)}
				onclick={() => choose(index)}
			>
				{#if option.icon}<span
						class="option-symbol"
						style:color={option.color ?? 'var(--accent, #bca9ff)'}
						><ChoiceArtwork name={option.icon} size={24} /></span
					>{:else if option.color}<span class="choice-dot" style:background={option.color}
					></span>{/if}
				<span class="option-copy">{option.label}</span>
				{#if value === option.value}<span class="option-check"><Icon name="check" size={13} /></span
					>{/if}
			</div>
		{/each}
	</div>
	{#if hasDescriptions}<div class="option-description" id={`${uid}-description`}>
			<span>{options[active]?.description ?? ''}</span>
		</div>{/if}
</div>

<style>
	.select-trigger {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
		min-height: 30px;
		padding: 5px 8px;
		border: 1px solid #eef0f612;
		border-radius: 6px;
		color: #dcdce9;
		background: #eef0f605;
		text-align: left;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.select-trigger:hover,
	.select-trigger.expanded {
		background: color-mix(in srgb, var(--accent, #bca9ff) 5%, transparent);
		border-color: color-mix(in srgb, var(--accent, #bca9ff) 22%, transparent);
	}
	.select-trigger:focus-visible {
		outline: 2px solid var(--accent, #bca9ff);
		outline-offset: 2px;
	}
	.select-trigger:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.select-trigger.compact {
		min-height: 26px;
		padding: 3px 6px;
		font-size: 10px;
	}
	.select-value {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.choice-symbol,
	.option-symbol {
		display: flex;
		flex: none;
		align-items: center;
	}
	.choice-dot {
		display: block;
		width: 6px;
		height: 6px;
		flex: none;
		border-radius: 50%;
	}
	.select-chevron {
		display: flex;
		flex: none;
		color: #999aaa;
		transition: transform 0.15s;
	}
	.expanded .select-chevron {
		transform: rotate(180deg);
	}
	.select-menu {
		position: fixed;
		box-sizing: border-box;
		inset: auto;
		margin: 0;
		padding: 5px;
		border: 1px solid color-mix(in srgb, var(--accent, #c8bddb) 18%, transparent);
		border-radius: 10px;
		background: #171a25;
		color: #eef0f6;
		overflow: hidden;
		overscroll-behavior: contain;
		box-shadow:
			0 12px 36px #0008,
			0 1px 0 #ffffff0a inset;
		font: inherit;
		animation: reveal 0.12s ease-out;
		scrollbar-width: thin;
		scrollbar-color: color-mix(in srgb, var(--accent, #bca9ff) 25%, transparent) transparent;
		outline: 0;
	}
	.select-menu:popover-open {
		display: flex;
		flex-direction: column;
	}
	.option-list {
		overflow: auto;
		min-height: 0;
		scrollbar-width: thin;
		scrollbar-color: color-mix(in srgb, var(--accent, #bca9ff) 25%, transparent) transparent;
	}
	.select-menu::backdrop {
		background: transparent;
	}
	.select-option {
		display: flex;
		align-items: center;
		gap: 9px;
		min-height: 28px;
		padding: 3px 7px;
		border-radius: 6px;
		cursor: pointer;
	}
	.select-option.highlighted {
		background: color-mix(in srgb, var(--accent, #bca9ff) 8%, transparent);
	}
	.select-option.chosen {
		color: color-mix(in srgb, var(--accent, #bca9ff) 85%, #fff);
	}
	.option-copy {
		flex: 1;
		min-width: 0;
		font-size: 11px;
		line-height: 1.4;
	}
	.option-description {
		flex: none;
		box-sizing: border-box;
		height: 53px;
		margin: 5px -5px -5px;
		padding: 8px 12px;
		border-top: 1px solid #ffffff0a;
		background: #111521;
		color: #989aad;
		font-size: 9px;
		line-height: 1.45;
	}
	.option-description span {
		display: -webkit-box;
		line-clamp: 3;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.option-check {
		display: flex;
		color: var(--accent, #bca9ff);
	}
	.option-group {
		padding: 7px 7px 3px;
		color: #9593a9;
		font-size: 10px;
	}
	@keyframes reveal {
		from {
			opacity: 0;
			transform: translateY(-3px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.select-menu {
			animation: none;
		}
		.select-trigger,
		.select-chevron {
			transition: none;
		}
	}
</style>
