<script lang="ts">
	import type { InspectionSample } from '#lib/gpu/contracts';
	import {
		INSPECTION_WINDOW_SECONDS,
		inspectionSegmentCrossesSeam,
		type InspectionHistory,
		type InspectionMetric
	} from '#lib/inspection-history';
	import {
		metricDefinition,
		isTopologyWorld,
		torusChart,
		type MetricId,
		type SceneDefinition,
		type Vec3
	} from '#lib/model';
	import Icon from './Icon.svelte';
	import ChoiceArtwork from './ChoiceArtwork.svelte';
	import HistoryCurve from './HistoryCurve.svelte';
	let {
		sample,
		scene,
		history = [],
		paused = false,
		onclose
	}: {
		sample: InspectionSample;
		scene: SceneDefinition;
		history?: InspectionHistory;
		paused?: boolean;
		onclose: () => void;
	} = $props();
	let cursorTick = $state<number | null>(null);
	let species = $derived(scene.species.find((item) => item.key === sample.speciesKey));
	let samples = $derived(history.length ? history : [sample]);
	let cursorIndex = $derived(
		cursorTick === null
			? samples.length - 1
			: Math.max(
					0,
					samples.findIndex((entry) => entry.tick >= cursorTick!)
				)
	);
	let selected = $derived(samples[cursorIndex] ?? sample);
	let elapsed = $derived(sample.simulationTime - samples[0].simulationTime);
	let baseColor = $derived(
		species
			? `hsl(${species.visual.hsl[0] * 360} ${species.visual.hsl[1] * 100}% ${species.visual.hsl[2] * 100}%)`
			: 'var(--aqua)'
	);
	const rows: { key: InspectionMetric; metric: MetricId; unit: string; color: string }[] = [
		{ key: 'speed', metric: 'speed', unit: 'u/s', color: 'var(--aqua)' },
		{ key: 'turnRate', metric: 'turn-rate', unit: 'rad/s', color: 'var(--lilac)' },
		{ key: 'acceleration', metric: 'acceleration', unit: 'u/s²', color: 'var(--amber)' },
		{ key: 'neighbors', metric: 'neighbor-count', unit: 'agents', color: 'var(--rose)' }
	];
	function number(value: number, digits = 2) {
		return Number.isFinite(value) ? value.toFixed(digits) : '—';
	}
	function minimumCeiling(key: InspectionMetric) {
		return key === 'turnRate' ? 0.1 : key === 'acceleration' ? 0.5 : 1;
	}

	let chart = $derived(
		scene.world.kind === 'surface' && scene.world.shape === 'torus'
			? torusChart(scene.world, selected.position)
			: null
	);
	let meshWorld = $derived(isTopologyWorld(scene.world));
	let uv = $derived.by(() => {
		if (meshWorld) return null;
		const [x, y, z] = selected.position;
		if (chart) return [chart.theta / (2 * Math.PI) + 0.5, chart.phi / (2 * Math.PI) + 0.5];
		if (scene.world.shape === 'plane')
			return [
				x / (2 * scene.world.halfExtents[0]) + 0.5,
				z / (2 * scene.world.halfExtents[1]) + 0.5
			];
		if (scene.world.shape === 'cylinder')
			return [Math.atan2(z, x) / (2 * Math.PI) + 0.5, y / (2 * scene.world.halfHeight) + 0.5];
		const radius = Math.hypot(x, y, z);
		return radius > 0
			? [
					Math.atan2(z, x) / (2 * Math.PI) + 0.5,
					Math.acos(Math.max(-1, Math.min(1, y / radius))) / Math.PI
				]
			: [0, 0];
	});
	let worldRadius = $derived.by(() => {
		const world = scene.world;
		if (world.shape === 'box' || world.shape === 'plane') return Math.hypot(...world.halfExtents);
		if (world.shape === 'torus') return world.majorRadius + world.tubeRadius;
		if (world.shape === 'cylinder') return Math.hypot(world.radius, world.halfHeight);
		return world.radius;
	});
	function project(position: Vec3) {
		const scale = 39 / Math.max(1, worldRadius);
		return [
			120 + (position[0] * 0.82 + position[2] * 0.55) * scale,
			43 + (position[0] * 0.32 - position[1] * 0.84 - position[2] * 0.48) * scale
		];
	}
	let motion = $derived.by(() => {
		const past = samples.slice(0, cursorIndex + 1);
		const path = past
			.map((entry, index) => {
				const prior = past[index - 1];
				// A periodic seam is a transition, not a straight journey across the whole world.
				const jump =
					prior && inspectionSegmentCrossesSeam(scene.world, prior.position, entry.position);
				const [x, y] = project(entry.position);
				return `${!index || jump ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
			})
			.join(' ');
		const [x, y] = project(selected.position);
		const [vx, vy] = [
			selected.velocity[0] * 0.82 + selected.velocity[2] * 0.55,
			selected.velocity[0] * 0.32 - selected.velocity[1] * 0.84 - selected.velocity[2] * 0.48
		];
		const magnitude = Math.hypot(vx, vy);
		return {
			path,
			x,
			y,
			angle: magnitude > 0.001 ? (Math.atan2(vy, vx) * 180) / Math.PI : 0,
			moving: magnitude > 0.001
		};
	});
	function scrub(event: Event) {
		cursorTick = samples[Number((event.currentTarget as HTMLInputElement).value)]?.tick ?? null;
	}
</script>

<aside
	class="inspector telemetry glass"
	aria-label="Selected agent inspector"
	data-samples={samples.length}
	data-selected-tick={selected.tick}
	data-latest-tick={sample.tick}
>
	<header>
		<div class="identity" style:color={baseColor}>
			<div class="body-glyph" title="Species body and base color">
				<ChoiceArtwork name={species?.body ?? 'arrow'} size={29} />
			</div>
			<div>
				<span class="eyebrow">Selected agent</span>
				<h2>{species?.name ?? 'Agent'} <span>#{sample.id}</span></h2>
			</div>
		</div>
		<button class="icon-button" aria-label="Close agent inspector" onclick={onclose}
			><Icon name="close" size={16} /></button
		>
	</header>
	<figure class="motion-figure" style:--agent-color={baseColor}>
		<svg
			viewBox="0 0 240 86"
			role="img"
			aria-label="Sampled agent trajectory in a fixed world projection. Position {selected.position
				.map((value) => number(value))
				.join(', ')}. Velocity {selected.velocity
				.map((value) => number(value))
				.join(', ')} units per second."
		>
			<path class="motion-guides" d="M82 59 120 43 158 59M120 43V13" />
			<circle class="origin" cx="120" cy="43" r="1.5" /><path class="motion-path" d={motion.path} />
			<circle class="selection-ring" cx={motion.x} cy={motion.y} r="6" />
			{#if motion.moving}<path
					class="velocity"
					d="M-3 0H13m-4-3 4 3-4 3"
					transform="translate({motion.x} {motion.y}) rotate({motion.angle})"
				/>{/if}
			<circle class="agent-point" cx={motion.x} cy={motion.y} r="2.3" />
			<path class="axes" d="M215 66 230 72M215 66 201 72M215 66V51" />
			<text x="233" y="75">x</text><text x="195" y="76">z</text><text x="213" y="47">y</text>
		</svg>
		<figcaption>
			<span>Trajectory <span class="quiet">world projection</span></span><span
				>{number(Math.min(elapsed, INSPECTION_WINDOW_SECONDS), 1)} s</span
			>
		</figcaption>
	</figure>
	<div class="history-heading">
		<span>History <span class="quiet">20 s window</span></span><button
			class="live-button"
			class:active={cursorTick === null}
			onclick={() => (cursorTick = null)}
			aria-pressed={cursorTick === null}
			>{cursorTick !== null ? 'Go live' : paused ? 'Paused' : 'Live'}<span class="live-dot"
			></span></button
		>
	</div>
	<dl class="inspect-metrics telemetry-metrics">
		{#each rows as row (row.key)}
			<div class="metric-row" style:--metric-color={row.color}>
				<div class="metric-caption">
					<dt title={metricDefinition(row.metric).description}>
						{metricDefinition(row.metric).label}
					</dt>
					<dd>
						{number(selected[row.key], row.key === 'neighbors' ? 0 : 2)}<span>{row.unit}</span>
					</dd>
				</div>
				<HistoryCurve
					history={samples}
					metric={row.key}
					label={metricDefinition(row.metric).label}
					unit={row.unit}
					color={row.color}
					ceiling={minimumCeiling(row.key)}
					selectedTick={selected.tick}
				/>
			</div>
		{/each}
	</dl>
	<div class="history-scrubber">
		<input
			type="range"
			min="0"
			max={Math.max(0, samples.length - 1)}
			step="1"
			value={cursorIndex}
			disabled={samples.length < 2}
			oninput={scrub}
			aria-label="History time"
			aria-valuetext={`${number(selected.simulationTime, 2)} simulation seconds, tick ${selected.tick}`}
		/>
		<div>
			<span>{number(samples[0].simulationTime, 1)} s</span><span
				>{number(selected.simulationTime, 2)} s</span
			><span>{number(sample.simulationTime, 1)} s</span>
		</div>
	</div>
	<details class="measurement-details">
		<summary>Coordinates & neighborhood <Icon name="chevron" size={11} /></summary>
		<dl class="inspect-vectors">
			<div>
				<dt>Position</dt>
				<dd>{selected.position.map((value) => number(value)).join(' · ')} <span>u</span></dd>
			</div>
			<div>
				<dt>Velocity</dt>
				<dd>{selected.velocity.map((value) => number(value)).join(' · ')} <span>u/s</span></dd>
			</div>
			{#if chart}<div>
					<dt>Tube θ · ring φ</dt>
					<dd>{number(chart.theta, 3)} · {number(chart.phi, 3)} <span>rad</span></dd>
				</div>{/if}
			{#if meshWorld}
				<div>
					<dt title="Connected surface face. Intersecting sheets retain separate face identities.">
						Surface face
					</dt>
					<dd>{selected.triangle === undefined ? '—' : `#${selected.triangle + 1}`}</dd>
				</div>
				<div>
					<dt
						title="Orientation transported along the surface, relative to this face’s local frame."
					>
						Local orientation
					</dt>
					<dd>
						{selected.orientation === 1 ? '+' : selected.orientation === -1 ? '−' : '—'}
						<span
							>{selected.orientation === -1
								? 'reversed'
								: selected.orientation === 1
									? 'transported'
									: ''}</span
						>
					</dd>
				</div>
			{:else if scene.world.kind === 'surface' && uv}<div>
					<dt>Surface UV</dt>
					<dd>{uv.map((value) => number(value, 3)).join(' · ')}</dd>
				</div>{/if}
			<div>
				<dt>Perception radius</dt>
				<dd>{number(species?.perception ?? 0)} <span>u</span></dd>
			</div>
			<div>
				<dt title={metricDefinition('density').description}>Density</dt>
				<dd>
					{number(selected.density, 3)} <span>u{scene.world.kind === 'surface' ? '⁻²' : '⁻³'}</span>
				</dd>
			</div>
			<div>
				<dt title={metricDefinition('anisotropy').description}>Anisotropy</dt>
				<dd>{number(selected.structure, 3)} <span>ratio</span></dd>
			</div>
		</dl>
	</details>
	<footer>
		<span>Sampled telemetry <span class="quiet">≈4 Hz</span></span><span
			>Tick {selected.tick.toLocaleString()}</span
		>
	</footer>
</aside>

<style>
	.telemetry {
		width: 280px;
		max-height: calc(100dvh - 195px);
		padding: 12px;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.identity {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.body-glyph {
		display: grid;
		place-items: center;
		width: 33px;
		height: 36px;
	}
	.telemetry > header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
	}
	.telemetry > header h2 {
		margin-top: 2px;
		color: var(--pearl);
		font-size: 13px;
	}
	.telemetry > header h2 span {
		color: var(--faint);
		font-size: 10px;
		font-weight: 400;
	}
	.telemetry > header .eyebrow {
		color: var(--faint);
		font-size: 8px;
	}
	.motion-figure {
		margin: 9px 0 12px;
	}
	.motion-figure svg {
		display: block;
		width: 100%;
		height: 86px;
	}
	.motion-guides {
		fill: none;
		stroke: var(--line);
		stroke-width: 0.7;
	}
	.origin {
		fill: var(--faint);
		opacity: 0.4;
	}
	.motion-path {
		fill: none;
		stroke: var(--agent-color);
		stroke-width: 1.2;
		stroke-linejoin: round;
		opacity: 0.65;
	}
	.selection-ring {
		fill: none;
		stroke: var(--agent-color);
		stroke-width: 0.8;
		opacity: 0.3;
	}
	.velocity {
		fill: none;
		stroke: var(--pearl);
		stroke-width: 1;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.agent-point {
		fill: var(--agent-color);
	}
	.axes {
		fill: none;
		stroke: var(--faint);
		stroke-width: 0.7;
		opacity: 0.7;
	}
	.motion-figure text {
		fill: var(--faint);
		font-size: 7px;
	}
	.motion-figure figcaption,
	.history-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		color: var(--muted);
		font-size: 9px;
	}
	.quiet {
		color: var(--faint);
		margin-left: 4px;
	}
	.history-heading {
		margin-bottom: 7px;
	}
	.live-button {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 2px 0 2px 6px;
		border: 0;
		background: none;
		color: var(--faint);
		font-size: 8px;
	}
	.live-button.active {
		color: var(--aqua);
	}
	.live-dot {
		width: 3px;
		height: 3px;
		border-radius: 50%;
		background: currentColor;
	}
	.telemetry-metrics {
		display: block;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.metric-row {
		margin: 0 0 7px;
	}
	.metric-caption {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		padding-bottom: 4px;
	}
	.metric-caption dt {
		color: var(--metric-color);
		font-size: 9px;
	}
	.telemetry-metrics .metric-caption dd {
		margin: 0;
		color: var(--pearl);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.telemetry-metrics .metric-caption dd span {
		color: var(--faint);
		font-size: 8px;
		margin-left: 4px;
	}
	.history-scrubber {
		margin: 8px 0 10px;
	}
	.history-scrubber input {
		--accent: var(--aqua);
		display: block;
		width: 100%;
		height: 16px;
		background: linear-gradient(var(--line), var(--line)) center / 100% 2px no-repeat;
		accent-color: var(--aqua);
	}
	.history-scrubber > div {
		display: flex;
		justify-content: space-between;
		margin-top: 2px;
		color: var(--faint);
		font-size: 8px;
		font-variant-numeric: tabular-nums;
	}
	.history-scrubber > div span:nth-child(2) {
		color: var(--muted);
	}
	.measurement-details {
		border-top: 1px solid var(--line);
		padding-top: 6px;
	}
	.measurement-details summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		list-style: none;
		color: var(--muted);
		font-size: 9px;
		cursor: pointer;
	}
	.measurement-details summary::-webkit-details-marker {
		display: none;
	}
	.measurement-details[open] summary :global(svg) {
		transform: rotate(180deg);
	}
	.inspect-vectors {
		margin: 9px 0 4px;
	}
	.inspect-vectors > div {
		display: flex;
		justify-content: space-between;
		gap: 6px;
		margin: 5px 0;
	}
	.inspect-vectors dt {
		color: var(--faint);
		font-size: 9px;
	}
	.inspect-vectors dd {
		margin: 0;
		color: var(--muted);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}
	.inspect-vectors dd span {
		font-size: 8px;
		color: var(--faint);
	}
	.telemetry footer {
		display: flex;
		justify-content: space-between;
		color: var(--faint);
		border-top: 1px solid var(--line);
		margin-top: 7px;
		padding-top: 6px;
		font-size: 8px;
	}
	@media (max-width: 700px) {
		.telemetry {
			max-height: calc(100dvh - 195px);
			width: min(280px, calc(100% - 20px));
		}
	}
</style>
