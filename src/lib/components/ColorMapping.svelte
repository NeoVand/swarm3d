<script lang="ts">
	import { METRICS, type ChannelMap } from '#lib/model';
	import CurveEditor from './CurveEditor.svelte';
	import Parameter from './Parameter.svelte';
	import Select from './Select.svelte';
	let {
		name,
		map,
		baseValue,
		onchange,
		onbasechange
	}: {
		name: 'hue' | 'saturation' | 'lightness';
		map: ChannelMap;
		baseValue: number;
		onchange: (patch: Partial<ChannelMap>) => void;
		onbasechange: (value: number) => void;
	} = $props();
	const uid = $props.id();
	let editor = $state(false);
	let title = $derived(name[0].toUpperCase() + name.slice(1));
	let sourceDefinition = $derived(METRICS.find((metric) => metric.id === map.source));
	let metricSource = $derived(map.source !== 'constant');
	let baseVisible = $derived(!metricSource || !map.enabled || map.strength < 1);
	let baseScale = $derived(name === 'hue' ? 360 : 100);
	let sourceOptions = $derived([
		{
			value: 'constant',
			label: 'Species',
			description: `Use the species ${name}.`,
			color:
				name === 'hue' ? 'var(--lilac)' : name === 'saturation' ? 'var(--rose)' : 'var(--amber)'
		},
		...METRICS.map((metric) => ({
			value: metric.id,
			label: metric.label,
			icon: metric.id,
			description: metric.description.split('. ')[0] + '.',
			group: 'Measurements'
		}))
	]);
</script>

<div class="color-mapping" data-channel={name} class:mapping-enabled={metricSource && map.enabled}>
	<div class="mapping-row">
		<label
			class="mapping-switch"
			title={metricSource ? `Enable ${name} mapping` : `Choose a metric to map ${name}`}
		>
			<input
				type="checkbox"
				aria-label={`Enable ${name} mapping`}
				checked={metricSource && map.enabled}
				disabled={!metricSource}
				onchange={(event) => onchange({ enabled: event.currentTarget.checked })}
			/>
		</label>
		<label class="mapping-label" for={`${uid}-source`}>{title}</label>
		<Select
			id={`${uid}-source`}
			label={`${title} source`}
			describedby={`${uid}-definition`}
			value={map.source}
			options={sourceOptions}
			size="compact"
			onchange={(value) => {
				const metric = METRICS.find((item) => item.id === value);
				onchange({
					source: value as ChannelMap['source'],
					enabled: value !== 'constant',
					range: metric?.range ?? [0, 1]
				});
			}}
		/>
		{#if metricSource}<button
				class="curve-toggle"
				class:active={editor}
				aria-label={`${title} curve`}
				aria-expanded={editor}
				aria-controls={`${uid}-editor`}
				title={`Edit ${name} curve`}
				onclick={() => (editor = !editor)}
			>
				<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"
					><path d="M3 16c8 0 3-12 14-12" stroke="currentColor" stroke-width="1.5" /></svg
				>
			</button>{/if}
	</div>
	<span class="sr-only" id={`${uid}-definition`}
		>{sourceDefinition
			? `${sourceDefinition.description} Units: ${sourceDefinition.unit}.`
			: `Uses this species’ base ${name}.`}</span
	>
	{#if metricSource}<Parameter
			label="Strength"
			value={map.strength * 100}
			min={0}
			max={100}
			step={1}
			digits={0}
			unit="%"
			disabled={!map.enabled}
			onchange={(value) => onchange({ strength: value / 100 })}
		/>
		{#if !map.enabled}<p class="mapping-status">Mapping off · edits apply when enabled.</p>
		{:else if map.strength === 0}<p class="mapping-status">0% · uses species {name}.</p>
		{:else if !baseVisible}<p class="mapping-status">Metric replaces species {name}.</p>{/if}
	{/if}
	{#if baseVisible}<Parameter
			label={metricSource ? `Base ${name}` : title}
			value={baseValue * baseScale}
			min={0}
			max={baseScale}
			step={1}
			digits={0}
			unit={name === 'hue' ? '°' : '%'}
			onchange={(value) => onbasechange(value / baseScale)}
		/>{/if}
	{#if metricSource && editor}<div class="mapping-editor" id={`${uid}-editor`}>
			<div class="field-row range-fields">
				<label class="field"
					>Input min<input
						type="number"
						step="0.1"
						value={map.range[0]}
						onchange={(event) => {
							const value = Number(event.currentTarget.value);
							if (Number.isFinite(value) && value < map.range[1])
								onchange({ range: [value, map.range[1]] });
						}}
					/></label
				>
				<label class="field"
					>Input max<input
						type="number"
						step="0.1"
						value={map.range[1]}
						onchange={(event) => {
							const value = Number(event.currentTarget.value);
							if (Number.isFinite(value) && value > map.range[0])
								onchange({ range: [map.range[0], value] });
						}}
					/></label
				>
			</div>
			<CurveEditor
				label={`${title} response`}
				points={map.curve.points.map(([x, y]) => ({ x, y }))}
				onchange={(points) => onchange({ curve: { points: points.map(({ x, y }) => [x, y]) } })}
			/>
		</div>{/if}
</div>

<style>
	.color-mapping {
		--channel: var(--lilac);
		--accent: var(--channel);
		padding: 8px 0;
	}
	.color-mapping[data-channel='saturation'] {
		--channel: var(--rose);
	}
	.color-mapping[data-channel='lightness'] {
		--channel: var(--amber);
	}
	.mapping-row {
		display: grid;
		grid-template-columns: 14px 64px minmax(0, 1fr) auto;
		align-items: center;
		gap: 6px;
		margin-bottom: 5px;
	}
	.mapping-label {
		color: var(--channel);
		font-size: 11px;
		font-weight: 500;
	}
	.mapping-switch {
		display: grid;
		place-items: center;
		width: 14px;
		height: 20px;
		cursor: pointer;
	}
	.mapping-switch input {
		box-sizing: border-box;
		appearance: none;
		margin: 0;
		width: 11px;
		height: 11px;
		border: 1px solid color-mix(in srgb, var(--faint) 45%, transparent);
		border-radius: 50%;
		background: transparent;
		cursor: pointer;
	}
	.mapping-switch input:checked {
		border: 3px solid var(--channel);
		background: var(--inset);
	}
	.mapping-switch input::before {
		content: none;
	}
	.mapping-switch input:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.mapping-switch input:focus-visible {
		outline: 2px solid var(--channel);
		outline-offset: 3px;
	}
	.curve-toggle {
		display: grid;
		place-items: center;
		width: 23px;
		height: 24px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.curve-toggle:hover,
	.curve-toggle.active {
		border-color: var(--line);
		background: color-mix(in srgb, var(--ink) 2%, transparent);
		color: var(--channel);
	}
	.curve-toggle:focus-visible {
		outline: 2px solid var(--channel);
		outline-offset: 2px;
	}
	.mapping-editor {
		margin: 5px 0 0 20px;
	}
	.range-fields {
		gap: 8px;
	}
	.range-fields .field {
		gap: 4px;
		color: var(--muted);
		font-size: 10px;
	}
	.range-fields input {
		height: 24px;
		padding: 3px 6px;
		font-size: 10px;
	}
	.mapping-status {
		margin: 0 0 3px 20px;
		color: var(--muted);
		font-size: 10px;
	}
</style>
