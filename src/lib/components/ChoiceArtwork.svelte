<script module lang="ts">
	type Mark = { x: number; y: number; radius?: number; peer?: boolean };
	type Symbol = {
		line: string;
		context?: string;
		peer?: string;
		dots?: Mark[];
		circle?: { x: number; y: number; radius: number };
	};
	const symbols: Record<string, Symbol> = {
		speed: { line: 'M9 16h19m-5-4 5 4-5 4', context: 'M3 10h10M3 16h3M3 22h10' },
		'turn-rate': { line: 'M7 26V15a9 9 0 0 1 18 0m-4-4 4 4 4-4', context: 'M7 23V12' },
		acceleration: { line: 'M14 16h14m-5-4 5 4-5 4', context: 'M4 13v6M8 11v10M12 9v14' },
		'neighbor-count': {
			line: 'M16 5V2M27 16h3M16 27v3M5 16H2',
			circle: { x: 16, y: 16, radius: 10 },
			dots: [
				{ x: 16, y: 16, radius: 2 },
				{ x: 12, y: 10, peer: true },
				{ x: 22, y: 14, peer: true },
				{ x: 11, y: 22, peer: true },
				{ x: 22, y: 22, peer: true }
			]
		},
		density: {
			line: 'M5 9V5h4M23 5h4v4M27 23v4h-4M9 27H5v-4',
			dots: [
				{ x: 10, y: 10 },
				{ x: 16, y: 10 },
				{ x: 22, y: 10 },
				{ x: 10, y: 16 },
				{ x: 16, y: 16, peer: true },
				{ x: 22, y: 16 },
				{ x: 10, y: 22 },
				{ x: 16, y: 22 },
				{ x: 22, y: 22 }
			]
		},
		anisotropy: {
			line: 'M7 25 25 7m-2 0h2v2',
			context: 'M3 21c-4-9 19-27 27-17 6 10-16 27-25 22',
			dots: [
				{ x: 10, y: 22 },
				{ x: 14, y: 18 },
				{ x: 18, y: 14 },
				{ x: 22, y: 10, peer: true }
			]
		},
		polarization: {
			line: 'M5 8h13l-3-3m3 3-3 3M10 16h16l-3-3m3 3-3 3M5 24h13l-3-3m3 3-3 3',
			context: 'M2 16h5'
		},
		'radial-flow': {
			line: 'M16 11V3m-3 3 3-3 3 3M21 18l7 5m-4 1 4-1-1-4M11 18l-7 5m1-4-1 4 4 1',
			dots: [{ x: 16, y: 16, peer: true, radius: 2 }]
		},
		'heading-azimuth': {
			line: 'M16 25V6m-4 6 4-6 4 6',
			circle: { x: 16, y: 16, radius: 12 },
			context: 'M4 16h24M16 4v24'
		},
		'center-distance': {
			line: 'M8 20 24 12M11 23l-5-6M26 15l-5-6',
			dots: [
				{ x: 5, y: 22, radius: 2 },
				{ x: 27, y: 10, peer: true, radius: 2 }
			],
			context: 'M8 4h4M24 28h4'
		},
		'center-bearing': {
			line: 'M7 25 25 7m-5 0h5v5',
			context: 'M7 25h20M7 25V5M18 25a11 11 0 0 0-3-8',
			dots: [{ x: 25, y: 7, peer: true, radius: 2 }]
		},
		'flow-orbit': {
			line: 'M7 26C4 12 13 5 25 8m-4-4 4 4-4 3',
			peer: 'M11 20c0-6 5-10 11-9m-3-3 3 3-3 2',
			context: 'M10 26c3-5 8-7 15-6'
		},
		'center-orbit-angle': {
			line: 'M8 24 23 9m-5 0h5v5M8 24h19m-3-3 3 3-3 3',
			context: 'M20 24a12 12 0 0 0-4-9',
			dots: [{ x: 8, y: 24, peer: true, radius: 2 }]
		},
		'center-radial-speed': {
			line: 'M4 16h15m-4-4 4 4-4 4',
			context: 'M24 5v22',
			dots: [{ x: 25, y: 16, peer: true, radius: 3 }]
		},
		'speed-contrast': {
			line: 'M3 9h25m-4-3 4 3-4 3',
			peer: 'M3 23h13m-4-3 4 3-4 3',
			context: 'M3 13v6M28 13v6'
		},
		ignore: { line: 'M3 9h12m-3-3 3 3-3 3', peer: 'M22 28V16m-3 3 3-3 3 3', context: 'M3 23 29 5' },
		flee: {
			line: 'M16 18H3m4-4-4 4 4 4',
			peer: 'M22 7h6m-3-3 3 3-3 3',
			context: 'M12 13 22 9',
			dots: [{ x: 24, y: 12, radius: 1, peer: true }]
		},
		chase: { line: 'M3 18h17m-4-4 4 4-4 4', peer: 'M21 10h8m-3-3 3 3-3 3', context: 'M8 23h8' },
		cohere: {
			line: 'M3 6l9 6m0-4v4H8M29 6l-9 6m4 0h-4V8M16 29V19m-3 4 3-4 3 4',
			dots: [{ x: 16, y: 16, peer: true, radius: 2.5 }]
		},
		align: {
			line: 'M4 24c0-10 5-13 15-12m-3-3 3 3-3 3',
			peer: 'M14 6h14m-3-3 3 3-3 3',
			context: 'M4 24l6-2'
		},
		orbit: {
			line: 'M7 25A12 12 0 1 1 27 23m-1-5 1 5-5-1',
			dots: [{ x: 16, y: 16, peer: true, radius: 3 }]
		},
		follow: {
			line: 'M3 25c5 0 7-3 8-8m-4 3 4-3 1 5M13 14c2-5 6-7 11-7m-4-3 4 3-4 3',
			peer: 'm26 6 4 1-3 3',
			context: 'M6 26C7 9 12 7 25 7'
		},
		guard: {
			line: 'M6 16v-6l10-6 10 6v6c0 7-10 12-10 12S6 23 6 16Z',
			peer: 'M14 16h4m-2-2 2 2-2 2',
			context: 'M6 16h5M21 16h5'
		},
		disperse: {
			line: 'M16 11V3m-3 3 3-3 3 3M21 19l7 7m-5 0h5v-5M11 19l-7 7m0-5v5h5',
			dots: [{ x: 16, y: 16, peer: true, radius: 2 }],
			context: 'M4 8 9 13M23 13l5-5'
		},
		mob: {
			line: 'M3 7l16 7m-2-4 2 4-4 1M3 16h16m-3-3 3 3-3 3M3 25l16-7m-4-1 4 1-2 4',
			dots: [{ x: 26, y: 16, peer: true, radius: 3 }]
		},
		mirror: { line: 'M16 23H3m4-4-4 4 4 4', peer: 'M16 9h13m-4-4 4 4-4 4', context: 'M4 16h24' },
		spiral: {
			line: 'M4 27C-5 0 36-2 28 21c-6 17-28-4-12-10 8-3 11 9 3 9m3-4-3 4-4-3',
			dots: [{ x: 16, y: 16, peer: true, radius: 1.5 }]
		}
	};
</script>

<script lang="ts">
	import { CURVE_PRESETS, evaluateCurve } from '#lib/model';
	let { name, size = 24 }: { name: string; size?: number } = $props();
	const palettes: Record<string, string[]> = {
		rainbow: ['#f09eb8', '#edc68a', '#71d7cf', '#89b8f1', '#bca9ff'],
		ocean: ['#3279a6', '#64b9de', '#71d7cf', '#bceadd'],
		bands: ['#ed91ab', '#edc68a', '#9ccf90', '#85bff1'],
		chrome: ['#6e7994', '#c9d2e7', '#f1f2fa', '#8b96b4'],
		mono: ['#3d4a62', '#8291ac', '#d9e1ef']
	};
	let palette = $derived(palettes[name]);
	let curve = $derived(CURVE_PRESETS.find((preset) => `curve-${preset.id}` === name));
	let symbol = $derived(symbols[name]);
	let curvePath = $derived(
		curve
			? Array.from(
					{ length: 25 },
					(_, index) =>
						`${index ? 'L' : 'M'}${4 + index} ${27 - evaluateCurve(curve.curve, index / 24) * 22}`
				).join(' ')
			: ''
	);
</script>

<svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
	{#if curve}
		<path d="M4 5v22h24" stroke="currentColor" stroke-opacity=".2" stroke-width="1" />
		<path d={curvePath} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
	{:else if palette}
		{#each palette as color, index (color)}
			<path
				d="M{5 + index * (22 / palette.length)} 23 L{9 + index * (22 / palette.length)} 9"
				stroke={color}
				stroke-width="3"
				stroke-linecap="round"
			/>
		{/each}
	{:else if symbol}
		{#if symbol.context}<path
				d={symbol.context}
				stroke="currentColor"
				stroke-width="1"
				stroke-opacity=".25"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>{/if}
		{#if symbol.circle}<circle
				cx={symbol.circle.x}
				cy={symbol.circle.y}
				r={symbol.circle.radius}
				stroke="currentColor"
				stroke-width="1"
				stroke-opacity=".25"
			/>{/if}
		<path
			d={symbol.line}
			stroke="currentColor"
			stroke-width="1.45"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		{#if symbol.peer}<path
				d={symbol.peer}
				stroke="#71d7cf"
				stroke-width="1.3"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>{/if}
		{#each symbol.dots ?? [] as dot, index (index)}<circle
				cx={dot.x}
				cy={dot.y}
				r={dot.radius ?? 1.3}
				fill={dot.peer ? '#71d7cf' : 'currentColor'}
			/>{/each}
	{:else if name === 'box' || name === 'volume' || name === 'obstacle'}
		<path
			d="m16 3 12 6v14l-12 6-12-6V9Z"
			fill="currentColor"
			fill-opacity=".08"
			stroke="currentColor"
			stroke-width="1.2"
		/>
		<path
			d="m4 9 12 6 12-6M16 15v14M16 3v12"
			stroke="currentColor"
			stroke-width="1.2"
			stroke-opacity=".6"
		/>
	{:else if name === 'sphere' || name === 'surface' || name === 'world'}
		<circle
			cx="16"
			cy="16"
			r="12"
			fill="currentColor"
			fill-opacity=".1"
			stroke="currentColor"
			stroke-width="1.2"
		/>
		<ellipse
			cx="16"
			cy="16"
			rx="5"
			ry="12"
			stroke="currentColor"
			stroke-opacity=".6"
			stroke-width="1"
			transform="rotate(-25 16 16)"
		/>
		<ellipse
			cx="16"
			cy="16"
			rx="12"
			ry="4.5"
			stroke="currentColor"
			stroke-opacity=".6"
			stroke-width="1"
			transform="rotate(-25 16 16)"
		/>
	{:else if name === 'plane'}
		<path
			d="m3 21 9-13 17 4-9 13Z"
			fill="currentColor"
			fill-opacity=".1"
			stroke="currentColor"
			stroke-width="1.2"
		/>
		<path d="m7.5 14.5 17 4M16 9l-9 13M23 10.5l-9 13" stroke="currentColor" stroke-opacity=".45" />
	{:else if name === 'cylinder'}
		<path
			d="M7 8v16c0 6 18 6 18 0V8"
			fill="currentColor"
			fill-opacity=".08"
			stroke="currentColor"
			stroke-width="1.2"
		/>
		<ellipse
			cx="16"
			cy="8"
			rx="9"
			ry="4.5"
			fill="currentColor"
			fill-opacity=".1"
			stroke="currentColor"
			stroke-width="1.2"
		/>
		<path d="M7 18c0 6 18 6 18 0M16 12.5v15" stroke="currentColor" stroke-opacity=".45" />
	{:else if name === 'torus'}
		<ellipse
			cx="16"
			cy="16"
			rx="13"
			ry="9"
			fill="currentColor"
			fill-opacity=".1"
			stroke="currentColor"
			stroke-width="1.2"
			transform="rotate(-25 16 16)"
		/>
		<ellipse
			cx="16"
			cy="16"
			rx="6.5"
			ry="3.5"
			stroke="currentColor"
			stroke-width="1.2"
			transform="rotate(-25 16 16)"
		/>
		<path d="M5 19c3 6 16 7 22-1" stroke="currentColor" stroke-opacity=".45" />
	{:else if name === 'arrow'}
		<path
			d="m16 4 11 23-11-6-11 6Z"
			fill="currentColor"
			fill-opacity=".18"
			stroke="currentColor"
			stroke-width="1.3"
		/><path d="M16 4v17" stroke="currentColor" stroke-opacity=".6" />
	{:else if name === 'cone'}
		<path
			d="m16 4 10 22c-5 4-15 4-20 0Z"
			fill="currentColor"
			fill-opacity=".16"
			stroke="currentColor"
			stroke-width="1.3"
		/><path d="M6 26c4-3 16-3 20 0" stroke="currentColor" stroke-opacity=".5" />
	{:else if name === 'diamond'}
		<path
			d="m16 3 10 13-10 13L6 16Z"
			fill="currentColor"
			fill-opacity=".16"
			stroke="currentColor"
			stroke-width="1.3"
		/><path d="M6 16h20M16 3v26" stroke="currentColor" stroke-opacity=".4" />
	{:else if name === 'ribbon'}
		<path
			d="M5 25C9 5 23 27 27 7M5 20C9 0 23 22 27 2"
			stroke="currentColor"
			stroke-width="1.3"
		/><path d="m5 25 0-5M27 7V2" stroke="currentColor" stroke-width="1.3" />
	{:else if name === 'disk' || name === 'ring'}
		<circle
			cx="16"
			cy="16"
			r="11"
			fill="currentColor"
			fill-opacity={name === 'disk' ? '.14' : '0'}
			stroke="currentColor"
			stroke-width="1.2"
		/>
		{#if name === 'ring'}<circle
				cx="16"
				cy="16"
				r="7"
				stroke="currentColor"
				stroke-opacity=".45"
			/>{:else}<circle cx="16" cy="16" r="2" fill="currentColor" />{/if}
	{:else}
		<path
			d="M4 23c9 0 7-14 24-14"
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
		/>
		<circle cx="7" cy="22" r="2" fill="currentColor" /><circle
			cx="16"
			cy="16"
			r="2"
			fill="currentColor"
			fill-opacity=".65"
		/><circle cx="25" cy="9.5" r="2" fill="currentColor" fill-opacity=".4" />
	{/if}
</svg>
