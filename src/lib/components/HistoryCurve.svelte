<script lang="ts">
	import {
		inspectionCurve,
		type InspectionHistory,
		type InspectionMetric
	} from '#lib/inspection-history';
	let {
		history,
		metric,
		label,
		unit,
		color,
		ceiling,
		selectedTick
	}: {
		history: InspectionHistory;
		metric: InspectionMetric;
		label: string;
		unit: string;
		color: string;
		ceiling: number;
		selectedTick: number;
	} = $props();
	let curve = $derived(inspectionCurve(history, metric, ceiling));
	let point = $derived(
		curve.points.find((entry) => entry.tick === selectedTick) ?? curve.points.at(-1)
	);
	let description = $derived(
		`${label} history over the last 20 simulation seconds. ${point ? `Selected value ${point.value.toFixed(metric === 'neighbors' ? 0 : 2)} ${unit}.` : 'Waiting for samples.'} Vertical scale 0 to ${curve.ceiling} ${unit}.`
	);
</script>

<svg
	class="history-curve"
	style:--curve-color={color}
	viewBox="0 0 240 32"
	role="img"
	aria-label={description}
>
	<path class="guide" d="M0 0H240M0 16H240M0 32H240" />
	<path class="area" d={curve.area} /><path class="line" d={curve.line} />
	{#if point}<path class="cursor" d="M{point.x} 0V32" /><circle
			cx={point.x}
			cy={point.y}
			r="2"
		/>{/if}
	<text x="235" y="9">{curve.ceiling >= 10 ? Math.round(curve.ceiling) : curve.ceiling}</text>
</svg>

<style>
	.history-curve {
		display: block;
		width: 100%;
		height: 32px;
		overflow: visible;
	}
	.guide {
		stroke: var(--line);
		stroke-width: 0.6;
		fill: none;
	}
	.area {
		fill: var(--curve-color);
		opacity: 0.065;
	}
	.line {
		stroke: var(--curve-color);
		stroke-width: 1.3;
		fill: none;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.cursor {
		stroke: var(--curve-color);
		stroke-width: 0.6;
		stroke-opacity: 0.28;
		fill: none;
	}
	circle {
		fill: var(--curve-color);
		stroke: var(--panel);
		stroke-width: 1;
	}
	text {
		text-anchor: end;
		fill: var(--faint);
		font-size: 7px;
		font-variant-numeric: tabular-nums;
	}
</style>
