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
</script>

<div class="parameter" class:disabled>
	<label for={uid} title={help}>{label}</label>
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
	<output for={uid}
		>{value.toLocaleString(undefined, { maximumFractionDigits: digits })}<small>{unit}</small
		></output
	>
	{#if help}<span id="{uid}-help" class="sr-only">{help}</span>{/if}
</div>
