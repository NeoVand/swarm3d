<script lang="ts">
	import { fade } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import {
		BEHAVIORS,
		METRICS,
		createDefaultOtherSpeciesRule,
		maxSurfaceObstacleRadius,
		projectWorldPoint,
		resizePopulation,
		worldBounds,
		worldInteractionLimit,
		type Behavior,
		type ChannelMap,
		type SceneDefinition,
		type SpeciesDefinition
	} from '#lib/model';
	import Icon from './Icon.svelte';
	import Parameter from './Parameter.svelte';
	import CurveEditor from './CurveEditor.svelte';
	import ColorMapping from './ColorMapping.svelte';
	import SurfaceDiagram from './SurfaceDiagram.svelte';
	import Select from './Select.svelte';
	import WorldGlyph from './WorldGlyph.svelte';
	import WorldDomainGlyph from './WorldDomainGlyph.svelte';
	import SwarmLogo from './SwarmLogo.svelte';
	import ForceGlyph from './ForceGlyph.svelte';
	import { worldHelp } from './world-help';
	import {
		VOLUME_SHAPES,
		SURFACE_SHAPES,
		counterpartShape,
		worldForChoice
	} from './world-selection';
	let {
		scene,
		onchange,
		section = $bindable('species'),
		onlibrary,
		onhelp,
		onclose,
		ontool,
		brandActive = true
	}: {
		scene: SceneDefinition;
		onchange: (next: SceneDefinition, reset?: boolean) => void;
		section?: string;
		onlibrary: () => void;
		onhelp: () => void;
		onclose: () => void;
		ontool?: (tool: 'force' | 'obstacle') => void;
		brandActive?: boolean;
	} = $props();
	const uid = $props.id();
	let selectedKey = $state('');
	let metricEditors = $state<string[]>([]);
	let rangeNotice = $state<{ world: string; text: string } | null>(null);
	let visibleRangeNotice = $derived(
		rangeNotice?.world === JSON.stringify(scene.world) ? rangeNotice.text : ''
	);
	let active = $derived(scene.species.find((item) => item.key === selectedKey) ?? scene.species[0]);
	let total = $derived(scene.species.reduce((sum, item) => sum + item.population, 0));
	let maxRadius = $derived(Math.min(20, worldInteractionLimit(scene.world) - 0.01));
	let minRadius = $derived(Math.min(0.5, maxRadius / 2));
	let rangeStep = $derived(
		scene.world.kind === 'surface' && scene.world.shape === 'torus' ? 0.01 : 0.1
	);
	let placementExtent = $derived(
		worldBounds(scene.world).reduce(
			(sum, value, index) => sum + value * Math.abs(scene.forces.workPlane.normal[index]),
			0
		)
	);
	let maxBodySize = $derived(
		Math.min(Math.max(1.5, active.size), bodySizeLimit(scene, active.key))
	);
	let maxObstacleRadius = $derived(
		scene.world.kind === 'surface' && scene.world.shape === 'torus'
			? maxSurfaceObstacleRadius(scene)
			: Math.min(20, worldInteractionLimit(scene.world) - 0.01)
	);
	let worldCopy = $derived(worldHelp(scene.world));
	const sections = [
		['species', 'Species'],
		['flocking', 'Flocking'],
		['interactions', 'Interactions'],
		['world', 'World'],
		['forces', 'Forces'],
		['appearance', 'Appearance'],
		['dynamics', 'Dynamics']
	];
	const metrics = METRICS;
	let worldOptions = $derived(scene.world.kind === 'volume' ? VOLUME_SHAPES : SURFACE_SHAPES);
	const behaviorColors: Record<Behavior, string> = {
		ignore: '#89929d',
		flee: '#f798af',
		chase: '#eab383',
		cohere: '#67d7de',
		align: '#b7a6eb',
		orbit: '#e6b078',
		follow: '#82c9b4',
		guard: '#87bedf',
		disperse: '#e2c279',
		mob: '#ef91a3',
		mirror: '#ce9cd9',
		spiral: '#78c9c9'
	};
	const behaviorLabels: Record<Behavior, string> = {
		ignore: 'Ignore',
		flee: 'Flee',
		chase: 'Chase',
		cohere: 'Cohere',
		align: 'Align',
		orbit: 'Orbit',
		follow: 'Follow',
		guard: 'Guard',
		disperse: 'Scatter',
		mob: 'Mob',
		mirror: 'Mirror',
		spiral: 'Spiral'
	};
	const behaviorDescriptions: Record<Behavior, string> = {
		ignore: 'Adds no directed force. A specific Ignore rule suppresses the fallback.',
		flee: 'Steer away from the target.',
		chase: 'Steer toward the target.',
		cohere: 'Move toward the target neighborhood center.',
		align: 'Match the target neighborhood velocity.',
		orbit: 'Move tangentially around the target with radial correction.',
		follow: 'Seek a position behind the target.',
		guard: 'Maintain a protective distance around the target.',
		disperse: 'Spread away from the neighborhood center.',
		mob: 'Converge as a group on the target.',
		mirror: 'Oppose the target neighborhood motion.',
		spiral: 'Combine inward motion with rotation.'
	};
	const behaviorOptions = BEHAVIORS.map((behavior) => ({
		value: behavior,
		label: behaviorLabels[behavior],
		description: behaviorDescriptions[behavior],
		color: behaviorColors[behavior],
		icon: behavior
	}));
	const metricOptions = metrics.map((metric) => ({
		value: metric.id,
		label: metric.label,
		description: metric.description,
		icon: metric.id,
		group: ['speed', 'turn-rate', 'acceleration', 'heading-azimuth'].includes(metric.id)
			? 'Motion'
			: 'Neighborhood'
	}));

	function bodySizeLimit(input: SceneDefinition, key?: string) {
		const upper = (worldInteractionLimit(input.world) - 0.01) / 4 - 0.001;
		if (input.world.kind !== 'surface' || input.world.shape !== 'torus') return upper;
		const probe = { ...input, species: input.species.map((species) => ({ ...species })) };
		function fits(size: number) {
			for (let index = 0; index < probe.species.length; index++) {
				const source = input.species[index];
				probe.species[index].size = key
					? source.key === key
						? size
						: source.size
					: Math.min(source.size, size);
			}
			return maxSurfaceObstacleRadius(probe) > 0.001;
		}
		if (fits(upper)) return upper;
		let lower = 0,
			higher = upper;
		for (let iteration = 0; iteration < 24; iteration++) {
			const middle = (lower + higher) / 2;
			if (fits(middle)) lower = middle;
			else higher = middle;
		}
		return lower;
	}
	function change(mutator: (next: SceneDefinition) => void, reset = false) {
		const next = structuredClone(scene);
		mutator(next);
		if (next.world.kind === 'surface') {
			const limit = worldInteractionLimit(next.world) - 0.01;
			const adjusted: string[] = [];
			function recordAdjustment(label: string) {
				if (!adjusted.includes(label)) adjusted.push(label);
			}
			function bounded(value: number, maximum: number, label: string) {
				if (value > maximum) recordAdjustment(label);
				return Math.min(value, maximum);
			}
			next.forces.radius = bounded(next.forces.radius, limit, 'pointer field');
			for (const species of next.species) {
				species.perception = bounded(species.perception, limit, 'perception');
				species.size = bounded(species.size, limit / 4 - 0.001, 'body sizes');
				for (const rule of species.metricRules)
					if (
						rule.radius !== null &&
						(next.world.shape !== 'torus' || (rule.behavior !== 'ignore' && rule.strength !== 0))
					)
						rule.radius = bounded(rule.radius, limit, 'metric rules');
			}
			for (const rule of next.speciesRules)
				if (
					rule.radius !== null &&
					(next.world.shape !== 'torus' || (rule.behavior !== 'ignore' && rule.strength !== 0))
				)
					rule.radius = bounded(rule.radius, limit, 'species rules');
			if (next.world.shape === 'torus') {
				const bodyLimit = bodySizeLimit(next);
				for (const species of next.species)
					species.size = bounded(species.size, bodyLimit, 'body sizes');
			}
			const obstacleLimit = next.world.shape === 'torus' ? maxSurfaceObstacleRadius(next) : limit;
			if (obstacleLimit <= 0 && next.obstacles.length) {
				next.obstacles = [];
				recordAdjustment('obstacles removed: body and avoidance margins fill the local range');
			}
			for (const obstacle of next.obstacles) {
				obstacle.center = projectWorldPoint(next.world, obstacle.center);
				if (obstacle.shape === 'sphere')
					obstacle.radius = bounded(obstacle.radius, obstacleLimit, 'obstacles');
			}
			if (adjusted.length)
				rangeNotice = {
					world: JSON.stringify(next.world),
					text: `Ranges adjusted for this surface: ${adjusted.join(', ')}. Local queries stay below ${worldInteractionLimit(next.world).toLocaleString(undefined, { maximumFractionDigits: 2 })} u.`
				};
		}
		onchange(next, reset);
	}
	function speciesChange(mutator: (item: SpeciesDefinition) => void, reset = false) {
		const key = active.key;
		change((next) => {
			const item = next.species.find((s) => s.key === key);
			if (item) mutator(item);
		}, reset);
	}
	function addSpecies() {
		const key = crypto.randomUUID();
		change((next) => {
			const item = structuredClone(active);
			item.key = key;
			item.name = `Species ${next.species.length + 1}`;
			item.population = 600;
			item.visual.hsl = [(active.visual.hsl[0] + 0.27) % 1, 0.62, 0.62];
			item.metricRules = [];
			next.species.push(item);
			next.speciesRules.push(createDefaultOtherSpeciesRule(item.key, next.speciesRules));
		});
		selectedKey = key;
		section = 'species';
	}
	function removeSpecies() {
		if (scene.species.length <= 1) return;
		const key = active.key;
		change((next) => {
			next.species = next.species.filter((item) => item.key !== key);
			next.speciesRules = next.speciesRules.filter((rule) => rule.from !== key && rule.to !== key);
		});
		selectedKey = '';
	}
	function setMode(kind: 'volume' | 'surface') {
		if (kind === scene.world.kind) return;
		setWorld(kind, counterpartShape(scene.world, kind));
	}
	function setWorld(kind: 'volume' | 'surface', shape: SceneDefinition['world']['shape']) {
		if (scene.world.kind === kind && scene.world.shape === shape) return;
		change((next) => {
			next.world = worldForChoice(next.world, kind, shape);
			next.obstacles = [];
			next.camera.target = [0, 0, 0];
			next.camera.distance = Math.hypot(...worldBounds(next.world)) * 1.9;
			next.camera.pitch = shape === 'plane' ? 0.7 : 0.3;
		}, true);
	}
	function addRule() {
		change((next) => {
			const targets = [
				'*',
				...next.species.filter((item) => item.key !== active.key).map((item) => item.key)
			];
			const to = targets.find(
				(target) =>
					!next.speciesRules.some((rule) => rule.from === active.key && rule.to === target)
			);
			if (to)
				next.speciesRules.push({
					id: crypto.randomUUID(),
					from: active.key,
					to,
					behavior: 'flee',
					strength: 1,
					radius: null
				});
		});
	}
	function ruleChange(id: string, patch: Record<string, unknown>) {
		change((next) => {
			const rule = next.speciesRules.find((item) => item.id === id);
			if (rule) Object.assign(rule, patch);
		});
	}
	function addMetricRule() {
		speciesChange((item) => {
			if (item.metricRules.length >= 2) return;
			item.metricRules.push({
				id: crypto.randomUUID(),
				metric: 'speed',
				role: 'neighbor',
				range: [0, 8],
				curve: {
					points: [
						[0, 0],
						[1, 1]
					]
				},
				behavior: 'align',
				strength: 1,
				radius: null
			});
		});
	}
	function metricChange(id: string, patch: Record<string, unknown>) {
		speciesChange((item) => {
			const rule = item.metricRules.find((r) => r.id === id);
			if (rule) Object.assign(rule, patch);
		});
	}
	function channelChange(channel: 'hue' | 'saturation' | 'lightness', patch: Partial<ChannelMap>) {
		speciesChange((item) => Object.assign(item.visual[channel], patch));
	}
	function baseColorChange(channel: 'hue' | 'saturation' | 'lightness', value: number) {
		speciesChange((item) => {
			const next: [number, number, number] = [...item.visual.hsl];
			next[['hue', 'saturation', 'lightness'].indexOf(channel)] = value;
			item.visual.hsl = next;
		});
	}
	function color(item: SpeciesDefinition) {
		return `hsl(${item.visual.hsl[0] * 360} ${item.visual.hsl[1] * 100}% ${item.visual.hsl[2] * 100}%)`;
	}
	let activeRules = $derived(scene.speciesRules.filter((rule) => rule.from === active.key));
	function targetOptions(ruleId: string) {
		return [
			{
				value: '*',
				label: 'All others',
				description: 'Fallback for every species without a specific rule.',
				icon: 'species'
			},
			...scene.species
				.filter((item) => item.key !== active.key)
				.map((item) => ({
					value: item.key,
					label: item.name,
					color: color(item),
					icon: 'species'
				}))
		].filter(
			(option) => !activeRules.some((rule) => rule.id !== ruleId && rule.to === option.value)
		);
	}
</script>

<aside class="laboratory" aria-label="Swarm laboratory" style:--species-color={color(active)}>
	<header class="lab-header">
		<span class="lab-brand"
			><SwarmLogo size={25} active={brandActive} /><span
				>Swarm<span class="brand-suffix">3D</span></span
			></span
		>
		<div class="header-actions">
			<button class="icon-button" aria-label="Open field guide" onclick={onhelp}
				><Icon name="help" size={15} /></button
			><button class="icon-button" aria-label="Hide laboratory (L)" onclick={onclose}
				><Icon name="close" size={14} /></button
			>
		</div>
	</header>
	<div class="lab-context">
		<button
			class="scene-title"
			aria-label="Scenes"
			title="Explore and save scenes"
			onclick={onlibrary}
			><Icon name="grid" size={12} /><span>{scene.name}</span><Icon name="down" size={10} /></button
		>
	</div>
	<div class="species-strip">
		<div class="species-chips" aria-label="Select species">
			{#each scene.species as item (item.key)}<button
					class:active={item.key === active.key}
					aria-pressed={item.key === active.key}
					aria-label={item.name}
					onclick={() => (selectedKey = item.key)}
					title={item.name}
					style="--species-color:{color(item)}"
				>
					<svg viewBox="0 0 24 24" aria-hidden="true"
						>{#if item.body === 'sphere'}<circle
								cx="12"
								cy="12"
								r="6"
							/>{:else if item.body === 'diamond'}<path
								d="m12 3 6 9-6 9-6-9Z"
							/>{:else if item.body === 'ribbon'}<path
								d="m6 18 4-12 4 12 4-12"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
							/>{:else}<path d="m12 4 7 15-7-4-7 4Z" />{/if}</svg
					>
				</button>{/each}
			<button
				class="species-add"
				aria-label="Add species"
				onclick={addSpecies}
				disabled={scene.species.length >= 8}><Icon name="plus" size={14} /></button
			>
		</div>
		<span class="active-species-name" title={active.name}>{active.name}</span>
	</div>
	<div class="lab-scroll">
		{#if visibleRangeNotice}<div class="info-card" role="status">
				<p>{visibleRangeNotice}</p>
				<button
					class="icon-button compact"
					aria-label="Dismiss range adjustment"
					onclick={() => (rangeNotice = null)}><Icon name="close" size={13} /></button
				>
			</div>{/if}
		{#each sections as item (item[0])}
			<section class={`lab-section section-${item[0]}`} class:expanded={section === item[0]}>
				<button
					class="section-toggle"
					aria-label={item[1]}
					aria-expanded={section === item[0]}
					aria-controls={`${uid}-${item[0]}`}
					onclick={() => (section = section === item[0] ? '' : item[0])}
				>
					<Icon name={item[0]} size={14} /><span>{item[1]}</span>
					{#if item[0] === 'interactions'}<small
							>{activeRules.filter((rule) => rule.behavior !== 'ignore' && rule.strength !== 0)
								.length +
								active.metricRules.filter(
									(rule) => rule.behavior !== 'ignore' && rule.strength !== 0
								).length} active</small
						>{:else if item[0] === 'flocking'}<small
							>{(active.cruiseSpeed ?? active.speed * 0.3).toFixed(1)} u/s</small
						>{:else if item[0] === 'world'}<small>{scene.world.shape}</small>{/if}
					<Icon name="down" size={12} />
				</button>
				{#if section === item[0]}<div
						class="section-content"
						id={`${uid}-${item[0]}`}
						in:fade={{ duration: prefersReducedMotion.current ? 0 : 130 }}
					>
						{@render sectionContent(item[0])}
					</div>{/if}
			</section>
		{/each}
	</div>
	<footer class="lab-footer">
		<span>{scene.species.length} species</span><span>{total.toLocaleString()} agents</span>
	</footer>
</aside>

{#snippet sectionContent(contentName: string)}
	{#if contentName === 'species'}
		<label class="field"
			>Name<input
				value={active.name}
				maxlength="60"
				onchange={(event) =>
					speciesChange((item) => (item.name = event.currentTarget.value || 'Untitled species'))}
			/></label
		>
		<Parameter
			label="Population"
			value={active.population}
			min={0}
			max={10000}
			step={100}
			digits={0}
			onchange={(value) => speciesChange((item) => (item.population = value))}
			help="Population changes retain existing agents where possible."
		/>
		<Parameter
			label="Total population"
			value={total}
			min={1}
			max={Math.max(20000, total)}
			step={1}
			digits={0}
			onchange={(value) => onchange(resizePopulation(scene, value))}
			help="Changing the explicit total redistributes agents proportionally across species and preserves surviving agents. The ordinary control ranges up to 20,000; larger imported scenes retain their current total."
		/>
		<div class="field-row">
			<div class="field">
				<span>Body</span><Select
					label="Body"
					value={active.body}
					options={['arrow', 'cone', 'diamond', 'sphere', 'ribbon'].map((body) => ({
						value: body,
						label: body[0].toUpperCase() + body.slice(1),
						icon: body,
						color: color(active)
					}))}
					onchange={(value) =>
						speciesChange((item) => (item.body = value as SpeciesDefinition['body']))}
				/>
			</div>
			<span class="field-note"
				>{total.toLocaleString()} agents<br />across {scene.species.length} species</span
			>
		</div>
		<Parameter
			label="Body size"
			value={active.size}
			min={Math.min(0.04, maxBodySize / 2)}
			max={maxBodySize}
			step={0.01}
			digits={2}
			unit="u"
			onchange={(value) => speciesChange((item) => (item.size = value))}
		/>
		<details class="control-group">
			<summary>Rebels <span>{Math.round(active.rebels.fraction * 100)}%</span></summary>
			<p class="group-note">A stable fraction periodically departs from the flock.</p>
			<Parameter
				label="Fraction"
				value={active.rebels.fraction * 100}
				min={0}
				max={100}
				step={1}
				digits={0}
				unit="%"
				onchange={(value) => speciesChange((item) => (item.rebels.fraction = value / 100))}
				help="A stable fraction of this species periodically departs from the flock. Its timing follows simulation time and the scene seed."
			/><Parameter
				label="Strength"
				value={active.rebels.strength}
				min={0}
				max={1}
				step={0.05}
				digits={2}
				onchange={(value) => speciesChange((item) => (item.rebels.strength = value))}
			/><Parameter
				label="Period"
				value={active.rebels.period}
				min={0.5}
				max={30}
				step={0.5}
				unit="s"
				onchange={(value) =>
					speciesChange((item) => {
						item.rebels.period = value;
						item.rebels.duration = Math.min(item.rebels.duration, value);
					})}
			/><Parameter
				label="Duration"
				value={active.rebels.duration}
				min={0.1}
				max={active.rebels.period}
				unit="s"
				onchange={(value) => speciesChange((item) => (item.rebels.duration = value))}
			/>
		</details>
		<button class="danger-button" disabled={scene.species.length === 1} onclick={removeSpecies}
			><Icon name="trash" size={14} />Remove {active.name}</button
		>
	{:else if contentName === 'flocking'}
		<h3 class="minor-heading">Movement · {active.name}</h3>
		<Parameter
			label="Speed limit"
			value={active.speed}
			min={0.1}
			max={20}
			unit="u/s"
			onchange={(value) =>
				speciesChange((item) => {
					const target = item.cruiseSpeed ?? item.speed * 0.3;
					item.speed = value;
					item.cruiseSpeed = Math.min(target, value);
				})}
			help="Upper speed bound. Reducing it also clamps the cruise target."
		/>
		<Parameter
			label="Cruise target"
			value={active.cruiseSpeed ?? active.speed * 0.3}
			min={0}
			max={active.speed}
			step={0.1}
			unit="u/s"
			onchange={(value) => speciesChange((item) => (item.cruiseSpeed = value))}
			help="Propulsion approaches this target within the shared acceleration limit. Interactions can temporarily slow agents below it. Zero disables propulsion."
		/>
		<Parameter
			label="Acceleration limit"
			value={active.force}
			min={0.1}
			max={30}
			unit="u/s²"
			onchange={(value) => speciesChange((item) => (item.force = value))}
			help="Shared acceleration budget for propulsion and steering."
		/>
		<hr />
		<h3 class="minor-heading">Flocking</h3>
		<Parameter
			label="Alignment"
			value={active.alignment}
			min={0}
			max={5}
			onchange={(value) => speciesChange((item) => (item.alignment = value))}
			help="Match nearby agents' velocity."
		/>
		<Parameter
			label="Cohesion"
			value={active.cohesion}
			min={0}
			max={5}
			onchange={(value) => speciesChange((item) => (item.cohesion = value))}
			help="Move toward the local flock center."
		/>
		<Parameter
			label="Separation"
			value={active.separation}
			min={0}
			max={5}
			onchange={(value) => speciesChange((item) => (item.separation = value))}
			help="Keep distance from close neighbors."
		/>
		<hr />
		<Parameter
			label="Perception"
			value={active.perception}
			min={minRadius}
			max={Math.min(12, maxRadius)}
			step={rangeStep}
			digits={2}
			unit="u"
			onchange={(value) => speciesChange((item) => (item.perception = value))}
			help={worldCopy.distance}
		/>
		<p class="group-note">
			Cruise is a target, not a minimum speed. Propulsion shares the acceleration budget with
			steering; zero turns it off.
		</p>
		{@render controlHelp('Flocking on this world', worldCopy.physics)}
	{:else if contentName === 'interactions'}
		<div class="subsection-heading">
			<h3>Species relationships</h3>
			<button
				class="icon-button compact"
				aria-label="Add species rule"
				onclick={addRule}
				disabled={activeRules.length >= scene.species.length}><Icon name="plus" size={14} /></button
			>
		</div>
		{#if !activeRules.length}<button class="empty-rule" onclick={addRule}
				><Icon name="plus" size={13} />Add a relationship</button
			>{/if}
		{#each activeRules as rule (rule.id)}
			<div
				data-rule-family="species"
				class="rule-card"
				class:rule-inactive={rule.behavior === 'ignore' || rule.strength === 0}
				style:--behavior-color={behaviorColors[rule.behavior]}
			>
				<div class="rule-main">
					<span class="rule-source" title={active.name} style:color={color(active)}
						><Icon name="species" size={15} /><span class="sr-only">{active.name}</span></span
					>
					<span class="rule-arrow" aria-hidden="true">→</span>
					<div class="rule-target">
						<Select
							label="Target species"
							value={rule.to}
							options={targetOptions(rule.id)}
							onchange={(value) => ruleChange(rule.id, { to: value })}
						/>
					</div>
					<div class="rule-behavior">
						<Select
							label="Behavior"
							value={rule.behavior}
							options={behaviorOptions}
							onchange={(value) => ruleChange(rule.id, { behavior: value })}
						/>
					</div>
					<button
						class="icon-button compact rule-remove"
						aria-label="Remove species rule"
						onclick={() =>
							change(
								(next) => (next.speciesRules = next.speciesRules.filter((r) => r.id !== rule.id))
							)}><Icon name="close" size={12} /></button
					>
				</div>
				<details class="rule-details">
					<summary
						aria-label={`Edit ${active.name} ${behaviorLabels[rule.behavior].toLowerCase()} rule`}
					>
						<span class="rule-state"
							>{rule.behavior === 'ignore'
								? 'Ignore override'
								: rule.strength === 0
									? 'Zero strength override'
									: `${rule.strength.toFixed(1)}× · ${rule.radius === null ? 'perception' : `${rule.radius.toFixed(1)} u`}`}{rule.to ===
							'*'
								? ' · fallback'
								: ''}</span
						><Icon name="down" size={11} />
					</summary>
					<div class="rule-settings">
						<Parameter
							label="Strength"
							value={rule.strength}
							min={0}
							max={5}
							disabled={rule.behavior === 'ignore'}
							onchange={(value) => ruleChange(rule.id, { strength: value })}
							help={behaviorDescriptions[rule.behavior]}
						/>
						<label class="toggle"
							><span>Use perception radius</span><input
								type="checkbox"
								checked={rule.radius === null}
								onchange={(event) =>
									ruleChange(rule.id, {
										radius: event.currentTarget.checked ? null : active.perception
									})}
							/></label
						>
						<Parameter
							label="Radius"
							disabled={rule.radius === null}
							value={rule.radius ?? active.perception}
							min={minRadius}
							max={rule.behavior === 'ignore' || rule.strength === 0
								? Math.max(maxRadius, rule.radius ?? active.perception)
								: maxRadius}
							step={rangeStep}
							digits={2}
							unit="u"
							onchange={(value) => ruleChange(rule.id, { radius: value })}
						/>
					</div>
				</details>
			</div>
		{/each}
		{@render controlHelp(
			'How species relationships work',
			'A specific target overrides All others, even when that rule is Ignore or has zero strength. Each relationship is directed: changing this species does not change the target’s response.'
		)}
		<div class="subsection-heading">
			<h3>Metric responses <span>{active.metricRules.length}/2</span></h3>
			<button
				class="icon-button compact"
				aria-label="Add metric rule"
				onclick={addMetricRule}
				disabled={active.metricRules.length >= 2}><Icon name="plus" size={14} /></button
			>
		</div>
		{#if !active.metricRules.length}<p class="group-note">
				Let motion or neighborhood measurements shape a response.
			</p>{/if}
		{#each active.metricRules as rule (rule.id)}
			<div
				class="rule-card metric-rule"
				data-rule-family="metric"
				class:rule-inactive={rule.behavior === 'ignore' || rule.strength === 0}
				style:--behavior-color={behaviorColors[rule.behavior]}
			>
				<div class="rule-main">
					<div class="rule-target">
						<Select
							label="Metric source"
							value={rule.metric}
							options={metricOptions}
							onchange={(value) => {
								const metric = metrics.find((item) => item.id === value)!;
								metricChange(rule.id, { metric: metric.id, range: metric.range });
							}}
						/>
					</div>
					<span class="rule-arrow" aria-hidden="true">→</span>
					<div class="rule-behavior">
						<Select
							label="Behavior"
							value={rule.behavior}
							options={behaviorOptions}
							onchange={(value) => metricChange(rule.id, { behavior: value })}
						/>
					</div>
					<button
						class="icon-button compact rule-remove"
						aria-label="Remove metric rule"
						onclick={() =>
							speciesChange(
								(item) => (item.metricRules = item.metricRules.filter((r) => r.id !== rule.id))
							)}><Icon name="close" size={12} /></button
					>
				</div>
				<details class="rule-details">
					<summary aria-label="Edit metric response"
						><span class="rule-state"
							>{rule.role[0].toUpperCase() + rule.role.slice(1)} · {rule.behavior === 'ignore'
								? 'Ignore'
								: `${rule.strength.toFixed(1)}×`} · {rule.radius === null
								? 'perception'
								: `${rule.radius.toFixed(1)} u`}</span
						><Icon name="down" size={11} /></summary
					>
					<div class="rule-settings">
						<div class="field-row">
							<div class="field">
								<span>Read from</span><Select
									label="Read from"
									value={rule.role}
									options={[
										{
											value: 'neighbor',
											label: 'Neighbor',
											description: 'The neighbor’s measurement activates this response.',
											icon: 'species'
										},
										{
											value: 'self',
											label: 'Self',
											description: 'This agent’s measurement activates its response to neighbors.',
											icon: 'inspect'
										},
										{
											value: 'difference',
											label: 'Difference',
											description:
												'The difference between the observer and neighbor activates this response.',
											icon: 'interactions'
										}
									]}
									onchange={(value) => metricChange(rule.id, { role: value })}
								/>
							</div>
							<button
								class="curve-toggle"
								class:active={metricEditors.includes(rule.id)}
								aria-label="Metric rule curve"
								aria-expanded={metricEditors.includes(rule.id)}
								title="Edit input range and response curve"
								onclick={() =>
									(metricEditors = metricEditors.includes(rule.id)
										? metricEditors.filter((id) => id !== rule.id)
										: [...metricEditors, rule.id])}
								><svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"
									><path d="M3 16c8 0 3-12 14-12" stroke="currentColor" stroke-width="1.5" /></svg
								></button
							>
						</div>
						{#if metricEditors.includes(rule.id)}
							<div class="field-row range-fields">
								<label class="field"
									>Input min<input
										type="number"
										step="0.1"
										value={rule.range[0]}
										onchange={(event) => {
											const value = Number(event.currentTarget.value);
											if (Number.isFinite(value) && value < rule.range[1])
												metricChange(rule.id, { range: [value, rule.range[1]] });
										}}
									/></label
								>
								<label class="field"
									>Input max<input
										type="number"
										step="0.1"
										value={rule.range[1]}
										onchange={(event) => {
											const value = Number(event.currentTarget.value);
											if (Number.isFinite(value) && value > rule.range[0])
												metricChange(rule.id, { range: [rule.range[0], value] });
										}}
									/></label
								>
							</div>
							<CurveEditor
								points={rule.curve.points.map(([x, y]) => ({ x, y }))}
								onchange={(points) =>
									metricChange(rule.id, { curve: { points: points.map(({ x, y }) => [x, y]) } })}
							/>
						{/if}
						<Parameter
							label="Strength"
							value={rule.strength}
							min={0}
							max={5}
							onchange={(value) => metricChange(rule.id, { strength: value })}
						/>
						<label class="toggle"
							><span>Use perception radius</span><input
								type="checkbox"
								checked={rule.radius === null}
								onchange={(event) =>
									metricChange(rule.id, {
										radius: event.currentTarget.checked ? null : active.perception
									})}
							/></label
						>
						<Parameter
							label="Radius"
							disabled={rule.radius === null}
							value={rule.radius ?? active.perception}
							min={minRadius}
							max={rule.behavior === 'ignore' || rule.strength === 0
								? Math.max(maxRadius, rule.radius ?? active.perception)
								: maxRadius}
							step={rangeStep}
							digits={2}
							unit="u"
							onchange={(value) => metricChange(rule.id, { radius: value })}
						/>
					</div>
				</details>
			</div>
		{/each}
	{:else if contentName === 'world'}
		<div class="world-domains" role="group" aria-label="Simulation domain">
			{#each ['volume', 'surface'] as kind (kind)}
				<button
					class="world-domain"
					class:active={scene.world.kind === kind}
					aria-pressed={scene.world.kind === kind}
					aria-label={kind === 'volume' ? 'Volume' : 'Surface'}
					title={kind === 'volume'
						? 'Move freely inside the world'
						: 'Move along the skin of the world'}
					onclick={() => setMode(kind as 'volume' | 'surface')}
				>
					<WorldDomainGlyph kind={kind as 'volume' | 'surface'} />
					<span
						><strong>{kind === 'volume' ? 'Volume' : 'Surface'}</strong><small
							>{kind === 'volume' ? 'Through space' : 'Along the skin'}</small
						></span
					>
				</button>
			{/each}
		</div>
		<div class="world-picker" role="group" aria-label="World shape">
			{#each worldOptions as world (world.value)}
				<button
					class="world-tile"
					class:active={scene.world.shape === world.value}
					aria-pressed={scene.world.shape === world.value}
					aria-label={`${world.label} world`}
					title={scene.world.kind === 'volume'
						? `Move inside a ${world.label.toLowerCase()}`
						: `Move along a ${world.label.toLowerCase()} surface`}
					onclick={() => setWorld(scene.world.kind, world.value)}
					><WorldGlyph
						shape={world.value}
						domain={scene.world.kind}
						active={scene.world.shape === world.value}
						size={38}
					/><span>{world.label}</span></button
				>
			{/each}
		</div>
		<div class="world-caption"><span>{worldCopy.description}</span></div>
		{#if scene.world.shape === 'box' || scene.world.shape === 'plane'}
			<div class="field">
				<span>Boundary</span><Select
					label="Boundary"
					value={scene.world.boundaries}
					options={[
						{
							value: 'reflect',
							label: 'Reflecting',
							description: 'Agents turn back at the physical boundary.',
							icon: 'obstacle'
						},
						{
							value: 'periodic',
							label: 'Periodic · wrap',
							description: 'Opposite faces join while motion stays continuous.',
							icon: 'orbit'
						}
					]}
					onchange={(value) =>
						change((next) => {
							if (next.world.shape === 'box' || next.world.shape === 'plane')
								next.world.boundaries = value as 'reflect' | 'periodic';
						})}
				/>
			</div>
			{#if scene.world.shape === 'box'}
				{#each ['Width', 'Height', 'Depth'] as axis, index (axis)}<Parameter
						label={axis}
						value={scene.world.halfExtents[index] * 2}
						min={8}
						max={100}
						step={1}
						digits={0}
						unit="u"
						onchange={(value) =>
							change((next) => {
								if (next.world.shape === 'box') {
									const values = [...next.world.halfExtents] as [number, number, number];
									values[index] = value / 2;
									next.world.halfExtents = values;
								}
							}, true)}
					/>{/each}
			{:else}
				{#each ['Width', 'Depth'] as axis, index (axis)}<Parameter
						label={axis}
						value={scene.world.halfExtents[index] * 2}
						min={8}
						max={100}
						step={1}
						digits={0}
						unit="u"
						onchange={(value) =>
							change((next) => {
								if (next.world.shape === 'plane') {
									const values = [...next.world.halfExtents] as [number, number];
									values[index] = value / 2;
									next.world.halfExtents = values;
								}
							}, true)}
					/>{/each}
			{/if}
		{:else if scene.world.shape === 'torus'}
			<Parameter
				label="Major radius"
				digits={2}
				value={scene.world.majorRadius}
				min={scene.world.tubeRadius * 2}
				max={Math.min(10000, scene.world.tubeRadius * 10)}
				step={0.5}
				unit="u"
				help="Center to the centerline of the tube. Between 2 and 10 times the tube radius."
				onchange={(value) =>
					change((next) => {
						if (next.world.shape === 'torus') next.world.majorRadius = value;
					}, true)}
			/>
			<Parameter
				label="Tube radius"
				digits={2}
				value={scene.world.tubeRadius}
				min={Math.max(1, scene.world.majorRadius / 10)}
				max={scene.world.majorRadius / 2}
				step={0.5}
				unit="u"
				help={scene.world.kind === 'surface'
					? 'Radius of the tube. Surface interaction ranges stay strictly below 0.3 times this radius.'
					: 'Radius of the solid tube. Agents move freely through its interior.'}
				onchange={(value) =>
					change((next) => {
						if (next.world.shape === 'torus') next.world.tubeRadius = value;
					}, true)}
			/>
			<p class="group-note">
				{scene.world.kind === 'surface'
					? 'Reducing the tube radius also adjusts local ranges and body sizes.'
					: 'A solid tube around an open center. Agents reflect at the curved wall.'}
			</p>
		{:else}
			<Parameter
				label={scene.world.shape === 'sphere' ? 'Sphere radius' : 'Cylinder radius'}
				value={scene.world.radius}
				min={4}
				max={40}
				step={0.5}
				unit="u"
				onchange={(value) =>
					change((next) => {
						if (next.world.shape === 'sphere' || next.world.shape === 'cylinder')
							next.world.radius = value;
					}, true)}
			/>
			{#if scene.world.shape === 'cylinder'}
				<Parameter
					label="Cylinder height"
					value={scene.world.halfHeight * 2}
					min={8}
					max={100}
					step={1}
					digits={0}
					unit="u"
					onchange={(value) =>
						change((next) => {
							if (next.world.shape === 'cylinder') next.world.halfHeight = value / 2;
						}, true)}
				/>
			{/if}
		{/if}
		<details class="control-reference world-reference">
			<summary aria-label="World geometry guide" title="World geometry and motion"
				><Icon name="help" size={13} /><span>Geometry guide</span></summary
			>
			<div class="reference-note">
				<p>{worldCopy.geometry}</p>
				{#if scene.world.kind === 'surface'}<SurfaceDiagram world={scene.world} />{/if}
			</div>
		</details>
		<label class="toggle"
			><span>Show world boundary</span><input
				type="checkbox"
				checked={scene.visual.showBoundary}
				onchange={(event) =>
					change((next) => (next.visual.showBoundary = event.currentTarget.checked))}
			/></label
		>
		<label class="toggle"
			><span>Show subtle grid</span><input
				type="checkbox"
				checked={scene.visual.showGrid ?? false}
				onchange={(event) => change((next) => (next.visual.showGrid = event.currentTarget.checked))}
			/></label
		>
		<div class="subsection-heading">
			<h3>Obstacles <span>{scene.obstacles.length}</span></h3>
			{#if ontool}<button class="text-button" onclick={() => ontool?.('obstacle')}
					><Icon name="pencil" size={12} />Paint</button
				>{/if}
			<button
				class="text-button"
				disabled={!scene.obstacles.length}
				onclick={() => change((next) => (next.obstacles = []))}>Clear</button
			>
		</div>
		{@render controlHelp(
			'Painting obstacles',
			'Choose Obstacle to paint, erase, or stamp a ring. Surface obstacles follow the surface; volume obstacles are editable spheres or boxes. Changes can be undone.'
		)}
		<label class="toggle"
			><span>Obstacle avoidance</span><input
				type="checkbox"
				checked={scene.obstacleSettings.enabled}
				onchange={(event) =>
					change((next) => (next.obstacleSettings.enabled = event.currentTarget.checked))}
			/></label
		><Parameter
			label="Avoidance strength"
			value={scene.obstacleSettings.strength}
			min={0}
			max={10}
			onchange={(value) => change((next) => (next.obstacleSettings.strength = value))}
		/>{#each scene.obstacles as obstacle, index (obstacle.id)}<div class="obstacle-row">
				<Icon name="obstacle" size={15} /><span
					>{obstacle.shape === 'sphere'
						? scene.world.kind === 'surface'
							? 'Disk'
							: 'Sphere'
						: 'Box'}
					{index + 1}<small>{obstacle.center.map((v) => v.toFixed(1)).join(' · ')}</small></span
				>{#if obstacle.shape === 'sphere'}<input
						aria-label="Obstacle {index + 1} radius"
						type="number"
						min={Math.min(0.2, maxObstacleRadius / 2)}
						max={maxObstacleRadius}
						step={scene.world.kind === 'surface' && scene.world.shape === 'torus' ? 0.01 : 0.2}
						value={obstacle.radius}
						onchange={(event) =>
							change((next) => {
								const target = next.obstacles.find((o) => o.id === obstacle.id);
								if (target?.shape === 'sphere')
									target.radius = Math.max(
										Math.min(0.2, maxObstacleRadius / 2),
										Math.min(maxObstacleRadius, Number(event.currentTarget.value) || 1)
									);
							})}
					/>{/if}<button
					class="icon-button compact"
					aria-label="Remove obstacle {index + 1}"
					onclick={() =>
						change((next) => (next.obstacles = next.obstacles.filter((o) => o.id !== obstacle.id)))}
					><Icon name="close" size={14} /></button
				>
			</div>{/each}
	{:else if contentName === 'forces'}
		{#if ontool}<button
				class="force-activation"
				onclick={() => {
					if (!scene.forces.enabled) change((next) => (next.forces.enabled = true));
					ontool?.('force');
				}}
				><ForceGlyph type="attract" size={23} /><span
					>Use Force tool<small>Move on the stage · press to boost</small></span
				><Icon name="chevron" size={12} /></button
			>{/if}
		<label class="toggle"
			><span>Enable pointer force</span><input
				type="checkbox"
				checked={scene.forces.enabled}
				onchange={(event) => change((next) => (next.forces.enabled = event.currentTarget.checked))}
			/></label
		>
		<div class="field">
			<span>Force footprint</span><Select
				label="Force footprint"
				value={scene.forces.shape}
				options={[
					{
						value: 'disk',
						label: 'Disk',
						description: 'Influence fills the field radius.',
						icon: 'disk'
					},
					{
						value: 'ring',
						label: 'Ring',
						description: 'Influence is strongest around the field’s edge.',
						icon: 'ring'
					}
				]}
				onchange={(value) => change((next) => (next.forces.shape = value as 'disk' | 'ring'))}
			/>
		</div>
		<Parameter
			label="Power"
			value={scene.forces.power}
			min={0}
			max={20}
			onchange={(value) => change((next) => (next.forces.power = value))}
		/><Parameter
			label="Radius"
			value={scene.forces.radius}
			min={minRadius}
			max={maxRadius}
			step={rangeStep}
			digits={2}
			unit="u"
			onchange={(value) => change((next) => (next.forces.radius = value))}
		/>{#if scene.world.kind === 'volume'}<Parameter
				label="Placement depth"
				value={scene.forces.depth}
				min={-placementExtent - scene.forces.workPlane.offset}
				max={placementExtent - scene.forces.workPlane.offset}
				unit="u"
				onchange={(value) => change((next) => (next.forces.depth = value))}
			/>
			<div class="field">
				<span>Work plane</span><Select
					label="Work plane"
					value={scene.forces.workPlane.normal[2] === 1
						? 'xy'
						: scene.forces.workPlane.normal[1] === 1
							? 'xz'
							: 'yz'}
					options={[
						{ value: 'xy', label: 'XY · front', icon: 'world' },
						{ value: 'xz', label: 'XZ · floor', icon: 'world' },
						{ value: 'yz', label: 'YZ · side', icon: 'world' }
					]}
					onchange={(value) =>
						change(
							(next) =>
								(next.forces.workPlane.normal =
									value === 'xy' ? [0, 0, 1] : value === 'xz' ? [0, 1, 0] : [1, 0, 0])
						)}
				/>
			</div>
			<Parameter
				label="Plane offset"
				value={scene.forces.workPlane.offset}
				min={-placementExtent - scene.forces.depth}
				max={placementExtent - scene.forces.depth}
				step={0.5}
				unit="u"
				onchange={(value) => change((next) => (next.forces.workPlane.offset = value))}
			/>{/if}
		<hr />
		<h3>{active.name} response</h3>
		<div class="force-polarity" role="group" aria-label="Pointer response">
			{#each ['attract', 'repel', 'ignore'] as response (response)}
				<button
					class:active={active.cursor.response === response}
					aria-pressed={active.cursor.response === response}
					aria-label={`${response[0].toUpperCase() + response.slice(1)} pointer`}
					title={`${active.name}: ${response}`}
					onclick={() =>
						speciesChange(
							(item) => (item.cursor.response = response as SpeciesDefinition['cursor']['response'])
						)}
					><ForceGlyph
						type={response as 'attract' | 'repel' | 'ignore'}
						active={active.cursor.response === response}
						size={27}
					/><span>{response[0].toUpperCase() + response.slice(1)}</span></button
				>
			{/each}
		</div>
		<Parameter
			label="Response strength"
			value={active.cursor.strength}
			min={0}
			max={5}
			onchange={(value) => speciesChange((item) => (item.cursor.strength = value))}
		/>
		<div class="vortex-response">
			<ForceGlyph
				type="vortex"
				active={active.cursor.vortex !== 0}
				direction={active.cursor.vortex}
				size={24}
			/><Parameter
				label="Vortex"
				value={active.cursor.vortex}
				min={-5}
				max={5}
				onchange={(value) => speciesChange((item) => (item.cursor.vortex = value))}
				help="Independent circulation. Negative and positive values reverse direction; zero switches it off."
			/>
		</div>
		{@render controlHelp(
			'Using the pointer field',
			'Select Force, then move over the stage. Press to boost. The field sits on the visible work plane in a volume, or follows the actual surface hit. Each species has its own response; vortex acts independently of attract or repel.'
		)}
	{:else if contentName === 'appearance'}
		<div class="palette-row" role="group" aria-label="Color palette">
			{#each ['rainbow', 'bands', 'ocean', 'chrome', 'mono'] as palette (palette)}
				<button
					class="palette-choice"
					class:active={scene.visual.palette === palette}
					aria-pressed={scene.visual.palette === palette}
					aria-label={`${palette[0].toUpperCase() + palette.slice(1)} palette`}
					onclick={() =>
						change(
							(next) => (next.visual.palette = palette as SceneDefinition['visual']['palette'])
						)}
				>
					<i class={`palette-swatch ${palette}`}></i>{palette[0].toUpperCase() + palette.slice(1)}
				</button>
			{/each}
		</div>
		<p class="fine-print palette-help">
			Species keeps the base color; palettes color the Hue metric.
		</p>
		<div class="channel-mappings">
			{#each ['hue', 'saturation', 'lightness'] as name (name)}
				{@const channel = name as 'hue' | 'saturation' | 'lightness'}
				<ColorMapping
					name={channel}
					map={active.visual[channel]}
					baseValue={active.visual.hsl[['hue', 'saturation', 'lightness'].indexOf(channel)]}
					onchange={(patch) => channelChange(channel, patch)}
					onbasechange={(value) => baseColorChange(channel, value)}
				/>
			{/each}
		</div>
		<details class="control-group">
			<summary>Trails</summary><Parameter
				label="History"
				value={active.trail.length}
				min={0}
				max={8}
				step={0.1}
				digits={1}
				unit="s"
				onchange={(value) => speciesChange((item) => (item.trail.length = value))}
			/><Parameter
				label="Width"
				value={active.trail.width}
				min={0.01}
				max={0.5}
				step={0.01}
				digits={2}
				unit="u"
				onchange={(value) => speciesChange((item) => (item.trail.width = value))}
			/><Parameter
				label="Opacity"
				value={active.trail.opacity * 100}
				min={0}
				max={100}
				step={1}
				digits={0}
				unit="%"
				onchange={(value) => speciesChange((item) => (item.trail.opacity = value / 100))}
			/>
			<p class="fine-print">
				History consumes GPU memory. The status strip reports the allocated trail buffer.
			</p>
		</details>

		<details class="control-group" open>
			<summary>Display</summary>
			<label class="field"
				>Background<input
					type="color"
					value={scene.visual.background}
					onchange={(event) =>
						change((next) => (next.visual.background = event.currentTarget.value))}
				/></label
			>
			<Parameter
				label="Exposure"
				value={scene.visual.exposure}
				min={0.2}
				max={3}
				step={0.05}
				digits={2}
				onchange={(value) => change((next) => (next.visual.exposure = value))}
			/><label class="toggle"
				><span>Bloom</span><input
					type="checkbox"
					checked={scene.visual.bloom}
					onchange={(event) => change((next) => (next.visual.bloom = event.currentTarget.checked))}
				/></label
			>
			<div class="field">
				<span>Render detail</span><Select
					label="Render detail"
					value={scene.visual.quality ?? 'balanced'}
					options={[
						{
							value: 'fast',
							label: 'Fast',
							description: 'Fewer display pixels for demanding scenes.',
							icon: 'dynamics'
						},
						{
							value: 'balanced',
							label: 'Balanced',
							description: 'A careful balance of crispness and frame time.',
							icon: 'appearance'
						},
						{
							value: 'sharp',
							label: 'Sharp',
							description: 'Native display resolution.',
							icon: 'inspect'
						}
					]}
					onchange={(value) =>
						change((next) => (next.visual.quality = value as SceneDefinition['visual']['quality']))}
				/>
			</div>
			<p class="fine-print" id={`${uid}-render-detail-help`}>
				Fast saves pixels; Sharp uses native detail. Population and physics stay the same.
			</p>
		</details>
	{:else if contentName === 'dynamics'}
		<div class="field">
			<span>Fixed timestep</span><Select
				label="Fixed timestep"
				value={String(scene.dynamics.fixedDt)}
				options={[
					{
						value: String(1 / 120),
						label: '1/120 second',
						description: 'Smaller physical steps; more GPU work.',
						icon: 'dynamics'
					},
					{
						value: String(1 / 60),
						label: '1/60 second',
						description: 'The standard simulation step.',
						icon: 'dynamics'
					},
					{
						value: String(1 / 30),
						label: '1/30 second',
						description: 'Larger physical steps.',
						icon: 'dynamics'
					}
				]}
				onchange={(value) => change((next) => (next.dynamics.fixedDt = Number(value)))}
			/>
		</div>
		<Parameter
			label="Maximum substeps"
			value={scene.dynamics.maxSubsteps}
			min={1}
			max={12}
			step={1}
			digits={0}
			onchange={(value) => change((next) => (next.dynamics.maxSubsteps = value))}
		/><Parameter
			label="Noise"
			value={scene.dynamics.noise}
			min={0}
			max={3}
			step={0.01}
			digits={2}
			onchange={(value) => change((next) => (next.dynamics.noise = value))}
		/><Parameter
			label="Collisions"
			value={scene.dynamics.collision}
			min={0}
			max={5}
			onchange={(value) => change((next) => (next.dynamics.collision = value))}
		/><Parameter
			label="Metric smoothing"
			value={scene.dynamics.metricSmoothingSeconds}
			min={0}
			max={2}
			step={0.05}
			digits={2}
			unit="s"
			onchange={(value) => change((next) => (next.dynamics.metricSmoothingSeconds = value))}
		/><label class="field"
			>Seed<input
				type="number"
				min="0"
				max="4294967295"
				step="1"
				value={scene.seed}
				onchange={(event) =>
					change(
						(next) =>
							(next.seed = Math.max(
								0,
								Math.min(4294967295, Math.floor(Number(event.currentTarget.value) || 0))
							)),
						true
					)}
			/></label
		>
		<p class="fine-print">
			The same seed reproduces the initial population. Device arithmetic can influence later
			trajectories.
		</p>
		<hr />
		<label class="toggle"
			><span>Auto-rotate camera</span><input
				type="checkbox"
				checked={scene.camera.autoRotate !== 0}
				onchange={(event) =>
					change((next) => (next.camera.autoRotate = event.currentTarget.checked ? 0.12 : 0))}
			/></label
		>
		<div class="field">
			<span>Orbit / vortex axis</span><Select
				label="Orbit / vortex axis"
				value={scene.dynamics.orbitAxis[2] === 1
					? 'z'
					: scene.dynamics.orbitAxis[0] === 1
						? 'x'
						: 'y'}
				options={[
					{ value: 'x', label: 'X axis', icon: 'orbit' },
					{ value: 'y', label: 'Y axis', icon: 'orbit' },
					{ value: 'z', label: 'Z axis', icon: 'orbit' }
				]}
				onchange={(value) =>
					change(
						(next) =>
							(next.dynamics.orbitAxis =
								value === 'x' ? [1, 0, 0] : value === 'z' ? [0, 0, 1] : [0, 1, 0])
					)}
			/>
		</div>
	{/if}
{/snippet}

{#snippet controlHelp(label: string, text: string)}
	<details class="control-reference">
		<summary aria-label={label} title={label}
			><Icon name="help" size={13} /><span>{label}</span></summary
		>
		<p class="reference-note">{text}</p>
	</details>
{/snippet}

<style>
	.world-domains {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 5px;
		margin: 0 0 8px;
	}
	.world-domain {
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 3px 4px;
		min-width: 0;
		border: 1px solid var(--line, #dae0ff14);
		border-radius: 7px;
		background: color-mix(in srgb, var(--inset, #05081130) 50%, transparent);
		text-align: left;
		color: var(--muted);
		--world-accent: var(--muted);
	}
	.world-domain span {
		display: grid;
		gap: 3px;
	}
	.world-domain strong {
		color: inherit;
		font-size: 11px;
		font-weight: 550;
	}
	.world-domain small {
		color: var(--faint);
		font-size: 8.5px;
		white-space: nowrap;
	}
	.world-domain:hover,
	.world-domain.active {
		color: var(--aqua);
		--world-accent: var(--aqua);
		border-color: color-mix(in srgb, var(--aqua) 35%, transparent);
		background: color-mix(in srgb, var(--aqua) 7%, transparent);
	}
	.world-domain.active small {
		color: var(--muted);
	}
	.world-picker {
		grid-template-columns: repeat(4, 1fr);
	}
</style>
