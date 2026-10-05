<script lang="ts">
	let {
		label,
		value,
		min,
		max,
		step = 0.1,
		unit = '',
		digits = 1,
		onchange,
		help = '',
		disabled = false
	}: {
		label: string;
		value: number;
		min: number;
		max: number;
		step?: number;
		unit?: string;
		digits?: number;
		onchange: (value: number) => void;
		help?: string;
		disabled?: boolean;
	} = $props();
	const uid = $props.id();
	let helpPosition = $state({ left: 12, top: 12 });
	let fill = $derived(
		Math.max(0, Math.min(100, ((value - min) / Math.max(max - min, 0.0001)) * 100))
	);
	function commit(input: HTMLInputElement) {
		const candidate = Number(input.value);
		if (!input.value.trim() || !Number.isFinite(candidate)) {
			input.value = String(value);
			return;
		}
		if (candidate === Number(value.toFixed(digits))) return;
		// Step controls gestures; an explicit number must not shift with a computed minimum.
		const bounded = Math.max(min, Math.min(max, candidate));
		if (bounded !== value) onchange(bounded);
	}
</script>

<div class="parameter" class:disabled style:--slider-fill={`${fill}%`}>
	<span class="parameter-label">
		<label for={uid}>{label}</label>
		{#if help}<button
				class="parameter-help"
				type="button"
				title={help}
				aria-label={`About ${label.toLowerCase()}`}
				aria-describedby={`${uid}-help`}
				popovertarget={`${uid}-help`}
				onclick={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					helpPosition = {
						left: Math.max(12, Math.min(window.innerWidth - 252, rect.right - 240)),
						top: Math.max(12, Math.min(window.innerHeight - 180, rect.bottom + 8))
					};
				}}>?</button
			>{/if}
	</span>
	<input
		id={uid}
		type="range"
		{min}
		{max}
		{step}
		{value}
		{disabled}
		aria-describedby={help ? `${uid}-help` : undefined}
		oninput={(event) => onchange(Number(event.currentTarget.value))}
	/>
	<span class="parameter-value">
		<input
			type="number"
			aria-label={`${label} value`}
			value={Number(value.toFixed(digits))}
			{min}
			{max}
			{step}
			{disabled}
			onchange={(event) => commit(event.currentTarget)}
			onkeydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					event.currentTarget.blur();
				}
				if (event.key === 'Escape') {
					event.currentTarget.value = String(Number(value.toFixed(digits)));
					event.currentTarget.blur();
				}
			}}
		/><small>{unit}</small>
	</span>
	{#if help}<div
			id={`${uid}-help`}
			class="parameter-tooltip"
			popover="auto"
			style:left={`${helpPosition.left}px`}
			style:top={`${helpPosition.top}px`}
		>
			<strong>{label}</strong>
			<p>{help}</p>
		</div>{/if}
</div>

<style>
	.parameter-tooltip {
		position: fixed;
		width: min(240px, calc(100vw - 24px));
		max-height: calc(100vh - 24px);
		overflow: auto;
		margin: 0;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--popover);
		color: var(--muted);
		box-shadow: 0 12px 35px var(--shadow);
		font-size: 11px;
		line-height: 1.6;
	}
	.parameter-tooltip strong {
		color: var(--pearl);
		font-size: 11px;
		font-weight: 500;
	}
	.parameter-tooltip p {
		margin: 4px 0 0;
	}
</style>
