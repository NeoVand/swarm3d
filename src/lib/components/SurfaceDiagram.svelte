<script lang="ts">
	import type { WorldDefinition } from '#lib/model';
	let { world }: { world: Extract<WorldDefinition, { kind: 'surface' }> } = $props();
	let description = $derived(
		world.shape === 'plane'
			? `Flat XZ plane with ${world.boundaries === 'periodic' ? 'joined opposite edges' : 'reflecting edges'}.`
			: world.shape === 'cylinder'
				? 'An open cylinder unrolls to a flat rectangle. Circular edges join, axial ends reflect.'
				: world.shape === 'torus'
					? 'A closed curved tube with major radius R and tube radius r. Local midpoint distances are approximate.'
					: 'A sphere has no edge. Motion follows great circles and distances follow arcs.'
	);
</script>

<figure class="surface-diagram">
	<svg viewBox="0 0 272 108" role="img" aria-label={description}>
		{#if world.shape === 'plane'}
			<path class="grid" d="M30 22h212v60H30zM83 22v60M136 22v60M189 22v60M30 42h212M30 62h212" />
			<path class:joined={world.boundaries === 'periodic'} class="edge" d="M30 22v60M242 22v60" />
			<path class:joined={world.boundaries === 'periodic'} class="edge" d="M30 22h212M30 82h212" />
			<path class="trajectory" d="M32 52h208" />
			<circle
				class="plane-particle"
				class:wrap={world.boundaries === 'periodic'}
				cx="32"
				cy="52"
				r="3"
			/>
			<text x="136" y="100" text-anchor="middle">X · {world.halfExtents[0] * 2} u</text>
			<text x="18" y="52" text-anchor="middle" transform="rotate(-90 18 52)"
				>Z · {world.halfExtents[1] * 2} u</text
			>
		{:else if world.shape === 'cylinder'}
			<path
				class="grid"
				d="M34 24a32 10 0 1 0 64 0 32 10 0 1 0-64 0M34 24v56c0 13 64 13 64 0V24M34 80c0-13 64-13 64 0"
			/>
			<path class="trajectory" d="M35 47c7 10 53 10 62 0" />
			<path class="unwrap" d="M108 52h20m-5-4 5 4-5 4" />
			<path
				class="grid"
				d="M142 22h114v60H142zM170 22v60M199 22v60M228 22v60M142 42h114M142 62h114"
			/>
			<path class="edge joined" d="M142 22v60M256 22v60" />
			<path class="edge" d="M142 22h114M142 82h114" />
			<path class="trajectory" d="M144 52h110" />
			<circle class="cylinder-particle" cx="144" cy="52" r="3" />
			<text x="199" y="100" text-anchor="middle"
				>2πR · {(world.radius * 2 * Math.PI).toFixed(1)} u</text
			>
			<text x="268" y="52" text-anchor="middle" transform="rotate(-90 268 52)"
				>{world.halfHeight * 2} u</text
			>
		{:else if world.shape === 'torus'}
			<ellipse class="grid" cx="136" cy="48" rx="85" ry="34" />
			<ellipse class="grid" cx="136" cy="48" rx="40" ry="16" />
			<ellipse class="grid" cx="136" cy="48" rx="62" ry="25" />
			<ellipse class="grid" cx="198" cy="48" rx="23" ry="25" />
			<path class="trajectory" d="M73 48c0-14 70-33 114-15" />
			<circle cx="187" cy="33" r="3" />
			<path class="unwrap" d="M136 48h62m-5-3 5 3-5 3M198 48h23m-5-3 5 3-5 3" />
			<text x="165" y="44">R</text><text x="207" y="44">r</text>
			<text x="99" y="19">φ</text><text x="215" y="76">θ</text>
			<text x="136" y="101" text-anchor="middle"
				>R · {world.majorRadius} u / r · {world.tubeRadius} u</text
			>
		{:else}
			<circle class="grid" cx="136" cy="52" r="39" />
			<ellipse class="grid" cx="136" cy="52" rx="17" ry="39" />
			<ellipse class="trajectory" cx="136" cy="52" rx="39" ry="14" transform="rotate(-24 136 52)" />
			<circle cx="168" cy="37" r="3" />
			<text x="136" y="104" text-anchor="middle">Radius · {world.radius} u</text>
		{/if}
	</svg>
	<figcaption>
		{world.shape === 'plane'
			? world.boundaries === 'periodic'
				? 'Opposite edges join. Motion wraps without changing direction.'
				: 'A flat chart. Motion reflects at each edge.'
			: world.shape === 'cylinder'
				? 'Unroll the surface. Amber edges are the same circular seam.'
				: world.shape === 'torus'
					? 'Both chart angles wrap. Local midpoint distances use the curved metric; queries remain below 0.3r.'
					: 'A great circle traces the shortest local arcs.'}
	</figcaption>
</figure>

<style>
	.surface-diagram {
		margin: 8px 0 0;
	}
	svg {
		width: 100%;
		display: block;
		overflow: visible;
	}
	path,
	ellipse,
	.grid {
		fill: none;
		stroke: color-mix(in srgb, var(--aqua) 25%, transparent);
		stroke-width: 1;
	}
	.edge {
		stroke: color-mix(in srgb, var(--aqua) 50%, transparent);
	}
	.joined {
		stroke: color-mix(in srgb, var(--amber) 66%, transparent);
		stroke-dasharray: 3 3;
	}
	.trajectory {
		stroke: var(--aqua);
		stroke-width: 1.5;
	}
	.unwrap {
		stroke: color-mix(in srgb, var(--muted) 50%, transparent);
	}
	circle:not(.grid) {
		fill: var(--rose);
	}
	text {
		fill: var(--muted);
		font-size: 8px;
		font-family: inherit;
	}
	figcaption {
		color: var(--muted);
		font-size: 10px;
		line-height: 1.5;
	}
	.plane-particle {
		animation: plane-motion 4s linear infinite alternate;
	}
	.plane-particle.wrap {
		animation-direction: normal;
	}
	.cylinder-particle {
		animation: cylinder-motion 3s linear infinite;
	}
	@keyframes plane-motion {
		to {
			transform: translateX(208px);
		}
	}
	@keyframes cylinder-motion {
		to {
			transform: translateX(110px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.plane-particle,
		.cylinder-particle {
			animation: none;
		}
	}
</style>
