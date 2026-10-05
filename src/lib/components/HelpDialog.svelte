<script lang="ts">
	import type { Snippet } from 'svelte';
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	import { SHORTCUTS } from './shortcuts';
	let {
		onclose,
		onsection,
		tour = false,
		notification
	}: {
		onclose: () => void;
		onsection: (section: string) => void;
		tour?: boolean;
		notification?: Snippet;
	} = $props();
	let step = $state(0);
	const steps = [
		{
			title: 'A small world, alive.',
			section: 'species',
			text: 'Swarm is a laboratory for collective motion. Begin with a scene, watch what emerges, then change one thing. Each species has its own motion, appearance, and response to other species.'
		},
		{
			title: 'Choose the space.',
			section: 'world',
			text: 'Volume gives agents a three-dimensional box. Surface offers a sphere, plane, open cylinder, or torus. Agents follow each surface’s physical distances and tangent motion. Choose the shape in World. Switching geometry starts a fresh population.'
		},
		{
			title: 'Give every gesture a purpose.',
			section: 'forces',
			text: 'Look orbits the camera. Force attracts, repels, or swirls agents on the visible volume work plane or actual surface. Obstacle paints spheres or boxes in a volume, disks along a surface, and rings of either. Inspect selects an individual and reveals its measured state. Two fingers pan and pinch to zoom.'
		},
		{
			title: 'Let relationships do the work.',
			section: 'interactions',
			text: 'Rules are directed: a species can chase another that flees it. A specific target overrides the All others fallback. Metric rules shape a response to a measured quantity; their curves can amplify, invert, or suppress it.'
		},
		{
			title: 'Read the motion.',
			section: 'appearance',
			text: 'Map hue, saturation, and lightness independently to speed, density, turning, and other measurements. Curves are editable with a pointer or arrow keys. The inspector shows samples at a known simulation tick.'
		},
		{
			title: 'Keep a discovery.',
			section: 'dynamics',
			text: 'Pause and step to study a moment. Save a scene locally, export its settings, share a link, or capture the canvas. Scenes retain parameters, seed, obstacles, and camera; loading begins a fresh simulation.'
		}
	];
	const shortcuts = SHORTCUTS;
</script>

<Modal
	title={tour ? 'Welcome to Swarm' : 'Field guide'}
	subtitle="Explore the rules. Follow the emergence."
	{onclose}
	notice={notification}
	wide
>
	{#if tour}
		<div class="tour-progress" aria-label="Tour progress">
			{#each steps as item, index (item.title)}<button
					class:active={index === step}
					aria-label="Step {index + 1}: {item.title}"
					onclick={() => {
						step = index;
						onsection(item.section);
					}}
				></button>{/each}
		</div>
		<div class="tour-content">
			<span class="eyebrow">{String(step + 1).padStart(2, '0')} / 06</span>
			<h3>{steps[step].title}</h3>
			<p>{steps[step].text}</p>
		</div>
		<div class="modal-actions">
			<button class="text-button" onclick={onclose}>Skip tour</button>
			<div>
				{#if step > 0}<button
						class="text-button"
						onclick={() => {
							step--;
							onsection(steps[step].section);
						}}>Back</button
					>{/if}<button
					class="primary-button"
					onclick={() => {
						if (step === steps.length - 1) onclose();
						else {
							step++;
							onsection(steps[step].section);
						}
					}}
					>{step === steps.length - 1 ? 'Start exploring' : 'Continue'}<Icon
						name="chevron"
						size={15}
					/></button
				>
			</div>
		</div>
	{:else}
		<div class="guide-grid">
			<section>
				<h3>Make an observation</h3>
				<p>
					Choose a species. Adjust flocking, then add a directed relationship or a metric rule. Save
					distinct results with a clear name.
				</p>
				<p>
					The cruise target keeps motion going through bounded propulsion. It shares the
					acceleration budget with steering, so interactions can temporarily slow an agent below its
					target. Set cruise to zero to disable propulsion.
				</p>
				<h3>Move through the world</h3>
				<p>
					In Look, drag to orbit, use the wheel to zoom, and right-drag to pan. On touch screens,
					use two fingers to pan and pinch. Select a tool before applying forces, placing obstacles,
					or picking an agent.
				</p>
				<h3>What the numbers mean</h3>
				<p>
					A plane uses flat XZ distances, with reflecting or periodic edges. A cylinder uses the
					exact distance on its unrolled surface: circular arc length combined with axial distance.
					Its ends reflect agents; its circular seam preserves motion. Sphere ranges stay below a
					quarter of a great circle, and cylinder ranges below half the circumference.
				</p>
				<p>
					The torus uses the metric of its visible curved tube. Its local midpoint distance estimate
					approximates nearby geodesic distances, with queries strictly below 0.3 times the tube
					radius. The major radius stays between 2 and 10 times the tube radius. The CPU audit found
					a largest measured distance error of 0.125% within this envelope; this sampled result is
					not a global error guarantee. Body and obstacle avoidance margins also fit within the
					local range.
				</p>
				<p>
					Render FPS counts displayed frames. Simulation time and tick count describe fixed steps.
					Achieved × compares simulated seconds with elapsed seconds; target is the requested time
					scale. A lower target deliberately slows motion. Rendering throughput and the step budget
					can reduce the achieved rate further. Inspector values are sampled from the GPU at the
					shown tick.
				</p>
				<h3>Reproduce a scene</h3>
				<p>
					Restart preserves the scene seed. Saves and shared links store settings and initial seed,
					not the current particle state. Exact trajectories can vary across GPU devices.
				</p>
			</section>
			<section>
				<h3>Keyboard</h3>
				<dl class="shortcuts">
					{#each shortcuts as shortcut (shortcut.id)}<div>
							<dt><kbd>{shortcut.label}</kbd></dt>
							<dd>{shortcut.description}</dd>
						</div>{/each}
				</dl>
				<p class="muted small">
					Shortcuts are disabled while editing text or when a dialog is open. Curve points support
					arrow keys, Shift for larger steps, and Delete for removal.
				</p>
			</section>
		</div>
		<div class="modal-actions">
			<button
				class="text-button"
				onclick={() => {
					step = 0;
					tour = true;
					onsection('species');
				}}>Take the guided tour</button
			><button class="primary-button" onclick={onclose}>Return to the swarm</button>
		</div>
	{/if}
</Modal>
