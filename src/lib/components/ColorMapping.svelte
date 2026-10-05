<script lang="ts">
	import { METRICS, type ChannelMap } from '#lib/model';
	import CurveEditor from './CurveEditor.svelte';
	import Parameter from './Parameter.svelte';
	let {
		name,
		map,
		onchange
	}: {
		name: 'hue' | 'saturation' | 'lightness';
		map: ChannelMap;
		onchange: (patch: Partial<ChannelMap>) => void;
	} = $props();
	const uid = $props.id();
	let editor = $state(false);
	let title = $derived(name[0].toUpperCase() + name.slice(1));
	let sourceDefinition = $derived(METRICS.find((metric) => metric.id === map.source));
</script>

<div class="color-mapping" data-channel={name} class:mapping-enabled={map.enabled}>
	<div class="mapping-row">
		<label class="mapping-switch" title={`Enable ${name} mapping`}>
			<input
				type="checkbox"
				aria-label={`Enable ${name} mapping`}
				checked={map.enabled}
				onchange={(event) => onchange({ enabled: event.currentTarget.checked })}
			/>
		</label>
		<label class="mapping-label" for={`${uid}-source`}>{title}</label>
		<select
			id={`${uid}-source`}
			aria-label={`${title} source`}
			aria-describedby={`${uid}-definition`}
			title={sourceDefinition?.description ?? `Uses this species’ base ${name}.`}
			value={map.source}
			onchange={(event) => {
				const metric = METRICS.find((item) => item.id === event.currentTarget.value);
				onchange({
					source: event.currentTarget.value as ChannelMap['source'],
					range: metric?.range ?? [0, 1]
				});
			}}
		>
			<option value="constant">Species</option>
			{#each METRICS as metric (metric.id)}<option value={metric.id}>{metric.label}</option>{/each}
		</select>
		<button
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
		</button>
	</div>
	<span class="sr-only" id={`${uid}-definition`}
		>{sourceDefinition
			? `${sourceDefinition.description} Units: ${sourceDefinition.unit}.`
			: `Uses this species’ base ${name}.`}</span
	>
	<Parameter
		label="Strength"
		value={map.strength * 100}
		min={0}
		max={100}
		step={1}
		digits={0}
		unit="%"
		onchange={(value) => onchange({ strength: value / 100 })}
	/>
	{#if editor}<div class="mapping-editor" id={`${uid}-editor`}>
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
