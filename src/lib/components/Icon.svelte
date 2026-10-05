<script lang="ts">
	let { name, size = 18 }: { name: string; size?: number } = $props();
	const paths: Record<string, string> = {
		lab: 'M9 3h6M10 3v6L5 18a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 15h8',
		play: 'm8 5 11 7-11 7Z',
		pause: 'M8 5v14M16 5v14',
		step: 'm5 5 10 7-10 7ZM19 5v14',
		reset: 'M3 10a9 9 0 1 1 2 9M3 4v6h6',
		close: 'm6 6 12 12M6 18 18 6',
		camera: 'M4 7h3l2-3h6l2 3h3v13H4ZM12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
		fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M9 9h6v6H9Z',
		video: 'M3 6h12v12H3ZM15 10l6-3v10l-6-3',
		stop: 'M6 6h12v12H6Z',
		help: 'M9 9a3 3 0 1 1 4 3c-1 .4-1 1-1 2M12 17h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
		chevron: 'm9 5 7 7-7 7',
		down: 'm5 9 7 7 7-7',
		back: 'm15 5-7 7 7 7',
		plus: 'M12 5v14M5 12h14',
		minus: 'M5 12h14',
		trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
		look: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
		force: 'M5 10V5h5M19 10V5h-5M5 5l5 5M19 5l-5 5M5 14v5h5M19 14v5h-5M5 19l5-5M19 19l-5-5',
		obstacle: 'm12 2 9 5v10l-9 5-9-5V7ZM3 7l9 5 9-5M12 12v10',
		inspect: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6M7 10h6M10 7v6',
		species: 'M4 17 12 3l8 14-8-4ZM6 21h12',
		flocking: 'm3 6 5 3-5 3M10 3l5 3-5 3M14 12l5 3-5 3',
		interactions: 'M5 5h5v5H5ZM14 14h5v5h-5ZM10 7h7v7M7 10v7h7',
		world: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20M12 2c5 6 5 14 0 20-5-6-5-14 0-20',
		appearance:
			'M12 3C6 3 3 7 3 12s4 9 9 9c3 0-1-5 2-5h3c6 0 5-13-5-13ZM7 10h.01M11 7h.01M16 8h.01M7 14h.01',
		dynamics: 'm13 2-9 12h7l-1 8 10-12h-7Z',
		save: 'M4 3h13l4 4v14H3V3ZM7 3v6h10V3M7 21v-7h10v7',
		share:
			'M8 12a4 4 0 0 1 0-6l3-3a4 4 0 0 1 6 6l-2 2M16 12a4 4 0 0 1 0 6l-3 3a4 4 0 0 1-6-6l2-2M9 15l6-6',
		export: 'M12 16V3m-4 4 4-4 4 4M4 15v6h16v-6',
		import: 'M12 3v13m-4-4 4 4 4-4M4 15v6h16v-6',
		dice: 'M4 4h16v16H4ZM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01',
		grid: 'M4 4h16v16H4ZM4 9h16M4 15h16M9 4v16M15 4v16',
		orbit: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 6c-4 3 1 11 9 14s13 0 9-4S9 3 5 4',
		check: 'm5 12 4 4L19 6',
		pencil: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-1 1 5 5',
		eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
		warning: 'm12 3 10 18H2ZM12 9v5M12 17h.01'
	};
	let path = $derived(paths[name] ?? paths.lab);
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.6"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"><path d={path} /></svg
>
