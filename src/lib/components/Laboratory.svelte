<script lang="ts">
	import {
		BEHAVIORS,
		METRICS,
		maxSurfaceObstacleRadius,
		projectWorldPoint,
		resizePopulation,
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
	import { SURFACE_SHAPES, worldHelp } from './world-help';
	let {
		scene,
		onchange,
		section = $bindable('species'),
		onlibrary,
		onhelp,
		onclose
	}: {
		scene: SceneDefinition;
		onchange: (next: SceneDefinition, reset?: boolean) => void;
		section?: string;
		onlibrary: () => void;
		onhelp: () => void;
		onclose: () => void;
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
	let rangeStep = $derived(scene.world.shape === 'torus' ? 0.01 : 0.1);
	let maxBodySize = $derived(
		Math.min(Math.max(1.5, active.size), bodySizeLimit(scene, active.key))
	);
	let maxObstacleRadius = $derived(
		scene.world.shape === 'torus'
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

	function bodySizeLimit(input: SceneDefinition, key?: string) {
		const upper = (worldInteractionLimit(input.world) - 0.01) / 4 - 0.001;
		if (input.world.shape !== 'torus') return upper;
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
		change((next) => {
			next.world =
				kind === 'volume'
					? { kind: 'volume', shape: 'box', halfExtents: [18, 12, 18], boundaries: 'reflect' }
					: { kind: 'surface', shape: 'sphere', radius: 14 };
			next.obstacles = [];
			next.camera.target = [0, 0, 0];
			next.camera.distance = kind === 'volume' ? 58 : 42;
			next.camera.pitch = 0.3;
		}, true);
	}
	function setSurface(shape: (typeof SURFACE_SHAPES)[number]['value']) {
		if (scene.world.shape === shape) return;
		change((next) => {
			next.world =
				shape === 'sphere'
					? { kind: 'surface', shape: 'sphere', radius: 14 }
					: shape === 'plane'
						? { kind: 'surface', shape: 'plane', halfExtents: [18, 18], boundaries: 'reflect' }
						: shape === 'cylinder'
							? { kind: 'surface', shape: 'cylinder', radius: 12, halfHeight: 14 }
							: { kind: 'surface', shape: 'torus', majorRadius: 20, tubeRadius: 8 };
			next.obstacles = [];
			next.camera.target = [0, 0, 0];
			next.camera.distance = shape === 'sphere' ? 42 : 58;
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
					behavior: 'cohere',
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
	function color(item: SpeciesDefinition) {
		return `hsl(${item.visual.hsl[0] * 360} ${item.visual.hsl[1] * 100}% ${item.visual.hsl[2] * 100}%)`;
	}
	let activeRules = $derived(scene.speciesRules.filter((rule) => rule.from === active.key));
</script>

<aside class="laboratory" aria-label="Swarm laboratory">
	<header class="lab-header">
		<button class="lab-brand" onclick={onlibrary} title="Explore and save scenes"
			><Icon name="lab" size={16} /><span>Swarm<span class="brand-suffix">3D</span></span><Icon
				name="down"
				size={10}
			/></button
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
		<button class="scene-title" onclick={onlibrary}
			><span>{scene.name}</span><Icon name="down" size={11} /></button
		>
		<div class="mode-switch" aria-label="Simulation domain">
			<button
				class:active={scene.world.kind === 'volume'}
				aria-pressed={scene.world.kind === 'volume'}
				onclick={() => setMode('volume')}>Volume</button
			><button
				class:active={scene.world.kind === 'surface'}
				aria-pressed={scene.world.kind === 'surface'}
				onclick={() => setMode('surface')}>Surface</button
			>
		</div>
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
			<section class="lab-section" class:expanded={section === item[0]}>
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
				{#if section === item[0]}<div class="section-content" id={`${uid}-${item[0]}`}>
						{@render sectionContent(item[0])}
					</div>{/if}
			</section>
		{/each}
	</div>
	<footer class="lab-footer">
		<button class="text-button" onclick={onlibrary}><Icon name="grid" size={12} />Scenes</button
		><span>{total.toLocaleString()} agents</span>
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
		<p class="group-note">
			The total redistributes proportionally across species, preserving survivors. More agents
			increase simulation cost; render detail leaves this total unchanged.
		</p>
		<div class="field-row">
			<label class="field"
				>Body<select
					value={active.body}
					onchange={(event) =>
						speciesChange(
							(item) => (item.body = event.currentTarget.value as SpeciesDefinition['body'])
						)}
					>{#each ['arrow', 'cone', 'diamond', 'sphere', 'ribbon'] as body (body)}<option
							value={body}>{body[0].toUpperCase() + body.slice(1)}</option
						>{/each}</select
				></label
			><span class="field-note"
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
		<details class="inline-help">
			<summary>About this control</summary>
			<div class="info-card">
				<Icon name="inspect" size={16} />
				<p>
					{worldCopy.physics}
				</p>
			</div>
		</details>
	{:else if contentName === 'interactions'}
		<div class="subsection-heading">
			<h3>Species rules</h3>
			<button
				class="icon-button compact"
				aria-label="Add species rule"
				onclick={addRule}
				disabled={activeRules.length >= scene.species.length}><Icon name="plus" size={16} /></button
			>
		</div>
		{#if !activeRules.length}<div class="empty-card">
				No directed rules yet.<br /><button class="text-button" onclick={addRule}
					>Add a relationship <Icon name="plus" size={13} /></button
				>
			</div>{/if}
		{#each activeRules as rule (rule.id)}<div
				data-rule-family="species"
				class="rule-card"
				class:rule-inactive={rule.behavior === 'ignore' || rule.strength === 0}
			>
				<div class="rule-heading">
					<span class="rule-source" title={active.name}
						><i class="color-dot" style="--species-color:{color(active)}"></i>{active.name}</span
					><span class="rule-arrow">→</span><select
						aria-label="Target species"
						value={rule.to}
						onchange={(event) => ruleChange(rule.id, { to: event.currentTarget.value })}
						><option value="*" disabled={activeRules.some((r) => r.id !== rule.id && r.to === '*')}
							>All others · fallback</option
						>{#each scene.species.filter((item) => item.key !== active.key) as target (target.key)}<option
								value={target.key}
								disabled={activeRules.some((r) => r.id !== rule.id && r.to === target.key)}
								>{target.name}</option
							>{/each}</select
					><button
						class="icon-button compact"
						aria-label="Remove species rule"
						onclick={() =>
							change(
								(next) => (next.speciesRules = next.speciesRules.filter((r) => r.id !== rule.id))
							)}><Icon name="close" size={14} /></button
					>
				</div>
				<label class="field"
					>Behavior<select
						value={rule.behavior}
						onchange={(event) => ruleChange(rule.id, { behavior: event.currentTarget.value })}
						>{#each BEHAVIORS as behavior (behavior)}<option value={behavior}
								>{behaviorLabels[behavior]}</option
							>{/each}</select
					></label
				>
				<span class="rule-state" title={behaviorDescriptions[rule.behavior]}
					>{rule.behavior === 'ignore'
						? 'Ignore override'
						: rule.strength === 0
							? 'Zero strength override'
							: 'Active'}</span
				>
				<Parameter
					label="Strength"
					value={rule.strength}
					min={0}
					max={5}
					disabled={rule.behavior === 'ignore'}
					onchange={(value) => ruleChange(rule.id, { strength: value })}
				/><label class="toggle"
					><span>Use perception radius</span><input
						type="checkbox"
						checked={rule.radius === null}
						onchange={(event) =>
							ruleChange(rule.id, {
								radius: event.currentTarget.checked ? null : active.perception
							})}
					/></label
				><Parameter
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
			</div>{/each}
		<p class="fine-print">
			A specific target overrides the fallback, including an explicit Ignore rule.
		</p>
		<div class="subsection-heading">
			<h3>Metric rules <span>{active.metricRules.length}/2</span></h3>
			<button
				class="icon-button compact"
				aria-label="Add metric rule"
				onclick={addMetricRule}
				disabled={active.metricRules.length >= 2}><Icon name="plus" size={16} /></button
			>
		</div>
		{#if !active.metricRules.length}<p class="group-note">
				Use a measured quantity to shape an additional steering response.
			</p>{/if}
		{#each active.metricRules as rule (rule.id)}<div
				class="rule-card metric-rule"
				data-rule-family="metric"
				class:rule-inactive={rule.behavior === 'ignore' || rule.strength === 0}
			>
				<div class="rule-heading">
					<select
						aria-label="Metric source"
						value={rule.metric}
						onchange={(event) => {
							const metric = metrics.find((m) => m.id === event.currentTarget.value)!;
							metricChange(rule.id, { metric: metric.id, range: metric.range });
						}}
						>{#each metrics as metric (metric.id)}<option value={metric.id}>{metric.label}</option
							>{/each}</select
					><button
						class="curve-toggle"
						class:active={metricEditors.includes(rule.id)}
						aria-label="Metric rule curve"
						aria-expanded={metricEditors.includes(rule.id)}
						title="Edit input range and response curve"
						onclick={() =>
							(metricEditors = metricEditors.includes(rule.id)
								? metricEditors.filter((id) => id !== rule.id)
								: [...metricEditors, rule.id])}
					>
						<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"
							><path d="M3 16c8 0 3-12 14-12" stroke="currentColor" stroke-width="1.5" /></svg
						>
					</button><button
						class="icon-button compact"
						aria-label="Remove metric rule"
						onclick={() =>
							speciesChange(
								(item) => (item.metricRules = item.metricRules.filter((r) => r.id !== rule.id))
							)}><Icon name="close" size={14} /></button
					>
				</div>
				<div class="field-row">
					<label class="field"
						>Read from<select
							value={rule.role}
							onchange={(event) => metricChange(rule.id, { role: event.currentTarget.value })}
							><option value="neighbor">Neighbor</option><option value="self">Self</option><option
								value="difference">Difference</option
							></select
						></label
					><label class="field"
						>Behavior<select
							value={rule.behavior}
							onchange={(event) => metricChange(rule.id, { behavior: event.currentTarget.value })}
							>{#each BEHAVIORS as behavior (behavior)}<option value={behavior}
									>{behaviorLabels[behavior]}</option
								>{/each}</select
						></label
					>
				</div>
				{#if metricEditors.includes(rule.id)}<div class="field-row range-fields">
						<label class="field"
							>Input min<input
								type="number"
								step="0.1"
								value={rule.range[0]}
								onchange={(event) => {
									const v = Number(event.currentTarget.value);
									if (Number.isFinite(v) && v < rule.range[1])
										metricChange(rule.id, { range: [v, rule.range[1]] });
								}}
							/></label
						><label class="field"
							>Input max<input
								type="number"
								step="0.1"
								value={rule.range[1]}
								onchange={(event) => {
									const v = Number(event.currentTarget.value);
									if (Number.isFinite(v) && v > rule.range[0])
										metricChange(rule.id, { range: [rule.range[0], v] });
								}}
							/></label
						>
					</div>
					<CurveEditor
						points={rule.curve.points.map(([x, y]) => ({ x, y }))}
						onchange={(points) =>
							metricChange(rule.id, { curve: { points: points.map(({ x, y }) => [x, y]) } })}
					/>{/if}<Parameter
					label="Strength"
					value={rule.strength}
					min={0}
					max={5}
					onchange={(value) => metricChange(rule.id, { strength: value })}
				/><label class="toggle"
					><span>Use perception radius</span><input
						type="checkbox"
						checked={rule.radius === null}
						onchange={(event) =>
							metricChange(rule.id, {
								radius: event.currentTarget.checked ? null : active.perception
							})}
					/></label
				><Parameter
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
			</div>{/each}
	{:else if contentName === 'world'}
		<div class="world-description">
			<Icon name="world" size={32} />
			<div>
				<h3>{worldCopy.title}</h3>
				<p>{worldCopy.description}</p>
			</div>
		</div>
		{#if scene.world.kind === 'surface'}
			<label class="field"
				>Surface shape<select
					value={scene.world.shape}
					onchange={(event) =>
						setSurface(event.currentTarget.value as (typeof SURFACE_SHAPES)[number]['value'])}
				>
					{#each SURFACE_SHAPES as shape (shape.value)}<option value={shape.value}
							>{shape.label}</option
						>{/each}
				</select></label
			>
		{/if}
		{#if scene.world.shape === 'box' || scene.world.shape === 'plane'}
			<label class="field"
				>Boundary<select
					value={scene.world.boundaries}
					onchange={(event) =>
						change((next) => {
							if (next.world.shape === 'box' || next.world.shape === 'plane')
								next.world.boundaries = event.currentTarget.value as 'reflect' | 'periodic';
						})}
					><option value="reflect">Reflecting</option><option value="periodic"
						>Periodic · wrap</option
					></select
				></label
			>
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
				help="Radius of the tube. Interaction ranges stay strictly below 0.3 times this radius."
				onchange={(value) =>
					change((next) => {
						if (next.world.shape === 'torus') next.world.tubeRadius = value;
					}, true)}
			/>
			<p class="group-note">
				The major radius stays between 2 and 10 times the tube radius. Reducing the tube radius also
				adjusts local ranges and body sizes.
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
		<details class="inline-help">
			<summary>About this control</summary>
			<div class="info-card">
				<Icon name="world" size={16} />
				<p>{worldCopy.geometry}</p>
			</div>
		</details>
		{#if scene.world.kind === 'surface'}<SurfaceDiagram world={scene.world} />{/if}
		<label class="toggle"
			><span>Show world boundary</span><input
				type="checkbox"
				checked={scene.visual.showBoundary}
				onchange={(event) =>
					change((next) => (next.visual.showBoundary = event.currentTarget.checked))}
			/></label
		>
		<div class="subsection-heading">
			<h3>Obstacles <span>{scene.obstacles.length}</span></h3>
			<button
				class="text-button"
				disabled={!scene.obstacles.length}
				onclick={() => change((next) => (next.obstacles = []))}>Clear</button
			>
		</div>
		<p class="group-note">
			Choose the Obstacle tool to paint, erase, or stamp a ring. Surface obstacles are disks
			measured along the surface; volume obstacles can also be boxes.
		</p>
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
						step={scene.world.shape === 'torus' ? 0.01 : 0.2}
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
		<label class="toggle"
			><span>Enable pointer force</span><input
				type="checkbox"
				checked={scene.forces.enabled}
				onchange={(event) => change((next) => (next.forces.enabled = event.currentTarget.checked))}
			/></label
		><label class="field"
			>Force footprint<select
				value={scene.forces.shape}
				onchange={(event) =>
					change((next) => (next.forces.shape = event.currentTarget.value as 'disk' | 'ring'))}
				><option value="disk">Disk</option><option value="ring">Ring</option></select
			></label
		><Parameter
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
				min={-20}
				max={20}
				unit="u"
				onchange={(value) => change((next) => (next.forces.depth = value))}
			/><label class="field"
				>Work plane<select
					value={scene.forces.workPlane.normal[2] === 1
						? 'xy'
						: scene.forces.workPlane.normal[1] === 1
							? 'xz'
							: 'yz'}
					onchange={(event) =>
						change(
							(next) =>
								(next.forces.workPlane.normal =
									event.currentTarget.value === 'xy'
										? [0, 0, 1]
										: event.currentTarget.value === 'xz'
											? [0, 1, 0]
											: [1, 0, 0])
						)}
					><option value="xy">XY · front</option><option value="xz">XZ · floor</option><option
						value="yz">YZ · side</option
					></select
				></label
			><Parameter
				label="Plane offset"
				value={scene.forces.workPlane.offset}
				min={-20}
				max={20}
				step={0.5}
				unit="u"
				onchange={(value) => change((next) => (next.forces.workPlane.offset = value))}
			/>{/if}
		<hr />
		<h3>{active.name} response</h3>
		<label class="field"
			>Pointer response<select
				value={active.cursor.response}
				onchange={(event) =>
					speciesChange(
						(item) =>
							(item.cursor.response = event.currentTarget
								.value as SpeciesDefinition['cursor']['response'])
					)}
				><option value="attract">Attract</option><option value="repel">Repel</option><option
					value="ignore">Ignore</option
				></select
			></label
		><Parameter
			label="Response strength"
			value={active.cursor.strength}
			min={0}
			max={5}
			onchange={(value) => speciesChange((item) => (item.cursor.strength = value))}
		/><Parameter
			label="Vortex"
			value={active.cursor.vortex}
			min={-5}
			max={5}
			onchange={(value) => speciesChange((item) => (item.cursor.vortex = value))}
		/>
		<details class="inline-help">
			<summary>About this control</summary>
			<div class="info-card">
				<Icon name="force" size={16} />
				<p>
					With Force selected, hover or drag to apply the field. A press boosts it. On a surface,
					the influence follows the selected geometry.
				</p>
			</div>
		</details>
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
					onchange={(patch) => channelChange(channel, patch)}
				/>
			{/each}
		</div>
		<details class="control-group">
			<summary
				>Species color <i class="color-dot" style="--species-color:{color(active)}"></i></summary
			>

			<Parameter
				label="Hue"
				value={active.visual.hsl[0] * 360}
				min={0}
				max={360}
				step={1}
				digits={0}
				unit="°"
				onchange={(value) =>
					speciesChange(
						(item) => (item.visual.hsl = [value / 360, item.visual.hsl[1], item.visual.hsl[2]])
					)}
			/><Parameter
				label="Saturation"
				value={active.visual.hsl[1] * 100}
				min={0}
				max={100}
				step={1}
				digits={0}
				unit="%"
				onchange={(value) =>
					speciesChange(
						(item) => (item.visual.hsl = [item.visual.hsl[0], value / 100, item.visual.hsl[2]])
					)}
			/><Parameter
				label="Lightness"
				value={active.visual.hsl[2] * 100}
				min={0}
				max={100}
				step={1}
				digits={0}
				unit="%"
				onchange={(value) =>
					speciesChange(
						(item) => (item.visual.hsl = [item.visual.hsl[0], item.visual.hsl[1], value / 100])
					)}
			/>
		</details>
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
			<label class="field"
				>Render detail<select
					value={scene.visual.quality ?? 'balanced'}
					aria-describedby={`${uid}-render-detail-help`}
					onchange={(event) =>
						change(
							(next) =>
								(next.visual.quality = event.currentTarget
									.value as SceneDefinition['visual']['quality'])
						)}
					><option value="fast">Fast</option><option value="balanced">Balanced</option><option
						value="sharp">Sharp</option
					></select
				></label
			>
			<p class="fine-print" id={`${uid}-render-detail-help`}>
				Fast saves pixels; Sharp uses native detail. Population and physics stay the same.
			</p>
		</details>
	{:else if contentName === 'dynamics'}
		<label class="field"
			>Fixed timestep<select
				value={scene.dynamics.fixedDt}
				onchange={(event) =>
					change((next) => (next.dynamics.fixedDt = Number(event.currentTarget.value)))}
				><option value={1 / 120}>1/120 second</option><option value={1 / 60}>1/60 second</option
				><option value={1 / 30}>1/30 second</option></select
			></label
		><Parameter
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
		><label class="field"
			>Orbit / vortex axis<select
				value={scene.dynamics.orbitAxis[2] === 1
					? 'z'
					: scene.dynamics.orbitAxis[0] === 1
						? 'x'
						: 'y'}
				onchange={(event) =>
					change(
						(next) =>
							(next.dynamics.orbitAxis =
								event.currentTarget.value === 'x'
									? [1, 0, 0]
									: event.currentTarget.value === 'z'
										? [0, 0, 1]
										: [0, 1, 0])
					)}
				><option value="x">X axis</option><option value="y">Y axis</option><option value="z"
					>Z axis</option
				></select
			></label
		>
	{/if}
{/snippet}
