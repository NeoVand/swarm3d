<script lang="ts">
	import type { InspectionSample } from '#lib/gpu/contracts';
	import { torusChart, type SceneDefinition } from '#lib/model';
	import Icon from './Icon.svelte';
	let {
		sample,
		scene,
		onclose
	}: { sample: InspectionSample; scene: SceneDefinition; onclose: () => void } = $props();
	let species = $derived(scene.species.find((item) => item.key === sample.speciesKey));
	function number(value: number, digits = 2) {
		return Number.isFinite(value) ? value.toFixed(digits) : '—';
	}
	let chart = $derived(
		scene.world.kind === 'surface' && scene.world.shape === 'torus'
			? torusChart(scene.world, sample.position)
			: null
	);
	let uv = $derived.by(() => {
		const [x, y, z] = sample.position;
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
</script>

<aside class="inspector glass" aria-label="Selected agent inspector">
	<header>
		<div>
			<span class="eyebrow">Selected agent</span>
			<h2>{species?.name ?? 'Agent'} <span>#{sample.id}</span></h2>
		</div>
		<button class="icon-button" aria-label="Close agent inspector" onclick={onclose}
			><Icon name="close" size={16} /></button
		>
	</header>
	<dl class="inspect-vectors">
		<div>
			<dt>Position</dt>
			<dd>{sample.position.map((v) => number(v)).join(' · ')} <span>u</span></dd>
		</div>
		<div>
			<dt>Velocity</dt>
			<dd>{sample.velocity.map((v) => number(v)).join(' · ')} <span>u/s</span></dd>
		</div>
		{#if chart}<div>
				<dt>Tube θ · ring φ</dt>
				<dd>{number(chart.theta, 3)} · {number(chart.phi, 3)} <span>rad</span></dd>
			</div>{/if}
		{#if scene.world.kind === 'surface'}<div>
				<dt>Surface UV</dt>
				<dd>{uv.map((v) => number(v, 3)).join(' · ')}</dd>
			</div>{/if}
	</dl>
	<dl class="inspect-metrics">
		<div>
			<dt>Speed</dt>
			<dd>{number(sample.speed)}<span>u/s</span></dd>
		</div>
		<div>
			<dt>Turning</dt>
			<dd>{number(sample.turnRate)}<span>rad/s</span></dd>
		</div>
		<div>
			<dt>Acceleration</dt>
			<dd>{number(sample.acceleration)}<span>u/s²</span></dd>
		</div>
		<div>
			<dt>Neighbors</dt>
			<dd>{number(sample.neighbors, 0)}</dd>
		</div>
		<div>
			<dt>Density</dt>
			<dd>
				{number(sample.density, 3)}<span>u{scene.world.kind === 'surface' ? '⁻²' : '⁻³'}</span>
			</dd>
		</div>
		<div>
			<dt>Anisotropy</dt>
			<dd>{number(sample.structure, 3)}<span>ratio</span></dd>
		</div>
	</dl>
	<footer>
		Sampled at tick {sample.tick.toLocaleString()} <span>{number(sample.simulationTime, 3)} s</span>
	</footer>
</aside>
