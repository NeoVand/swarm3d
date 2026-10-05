<script lang="ts">
	import { CURVE_PRESETS, evaluateCurve, type MonotoneCurve } from '#lib/model';
	let {
		points,
		onchange,
		label = 'Response curve'
	}: {
		points: { x: number; y: number }[];
		onchange: (points: { x: number; y: number }[]) => void;
		label?: string;
	} = $props();
	let selected = $state(0);
	let drag: { index: number; element: HTMLElement } | null = null;
	const uid = $props.id();
	const presets = CURVE_PRESETS;
	let curve: MonotoneCurve = $derived({ points: points.map(({ x, y }) => [x, y]) });
	let path = $derived(
		Array.from(
			{ length: 65 },
			(_, i) => `${i ? 'L' : 'M'} ${8 + (i / 64) * 244} ${104 - evaluateCurve(curve, i / 64) * 96}`
		).join(' ')
	);
	function update(index: number, x: number, y: number) {
		const point = points[index];
		if (!point) return;
		const next = points.map((p) => ({ ...p }));
		next[index] = {
			x:
				point.x === 0 || point.x === 1
					? point.x
					: Math.max(
							(points[index - 1]?.x ?? 0) + 0.001,
							Math.min((points[index + 1]?.x ?? 1) - 0.001, x)
						),
			y: Math.max(0, Math.min(1, y))
		};
		onchange(next);
	}
	function move(event: PointerEvent) {
		if (!drag) return;
		const rect = drag.element.getBoundingClientRect();
		update(
			drag.index,
			(((event.clientX - rect.left) / rect.width) * 260 - 8) / 244,
			(104 - ((event.clientY - rect.top) / rect.height) * 112) / 96
		);
	}
	function start(event: PointerEvent, index: number) {
		event.preventDefault();
		selected = index;
		const button = event.currentTarget as HTMLButtonElement;
		drag = { index, element: button.parentElement! };
		button.setPointerCapture(event.pointerId);
	}
	function add(event?: MouseEvent) {
		if (points.length >= 32) return;
		let x = 0.5,
			y = 0.5;
		if (event) {
			const rect =
				event.currentTarget instanceof HTMLElement
					? event.currentTarget.getBoundingClientRect()
					: null;
			if (rect) {
				x = Math.max(0.03, Math.min(0.97, (event.clientX - rect.left) / rect.width));
				y = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
			}
		}
		if (points.some((p) => Math.abs(p.x - x) < 0.01)) {
			const gap = points
				.slice(1)
				.map((point, index) => ({ start: points[index].x, width: point.x - points[index].x }))
				.sort((a, b) => b.width - a.width)[0];
			x = gap.start + gap.width / 2;
		}
		const next = [...points.map((p) => ({ ...p })), { x, y }].sort((a, b) => a.x - b.x);
		selected = next.findIndex((p) => p.x === x);
		onchange(next);
	}
	function remove(index = selected) {
		if (points.length <= 2 || points[index]?.x === 0 || points[index]?.x === 1) return;
		onchange(points.filter((_, i) => i !== index));
		selected = Math.max(0, index - 1);
	}
	function key(event: KeyboardEvent, index: number) {
		const amount = event.shiftKey ? 0.1 : 0.01;
		if (event.key.startsWith('Arrow')) {
			event.preventDefault();
			event.stopPropagation();
			const p = points[index];
			update(
				index,
				p.x + (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0),
				p.y + (event.key === 'ArrowUp' ? amount : event.key === 'ArrowDown' ? -amount : 0)
			);
		}
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			remove(index);
		}
	}
</script>

<div class="curve-editor">
	<div class="curve-heading">
		<span>{label}</span><select
			aria-label="Curve preset"
			value=""
			onchange={(event) => {
				const preset = presets[Number(event.currentTarget.value)];
				if (preset) {
					onchange(preset.curve.points.map(([x, y]) => ({ x, y })));
					selected = 0;
				}
				event.currentTarget.value = '';
			}}
			><option value="" disabled>Presets</option
			>{#each presets as preset, index (preset.name)}<option value={index}>{preset.name}</option
				>{/each}</select
		>
	</div>
	<div class="curve-plot">
		<button class="curve-add-surface" aria-label="Add curve point at pointer position" onclick={add}
		></button>
		<svg viewBox="0 0 260 112" aria-hidden="true"
			><defs
				><linearGradient id={uid} x1="0" y1="1" x2="0" y2="0"
					><stop stop-color="#80b6b9" stop-opacity="0.02" /><stop
						offset="1"
						stop-color="#a4b8ed"
						stop-opacity="0.2"
					/></linearGradient
				></defs
			><path d="M8 56H252M130 8V104" stroke="#ffffff0d" /><path
				d="M8 104 252 8"
				stroke="#ffffff15"
				stroke-dasharray="3 5"
			/><path d="{path} L252 104 L8 104Z" fill="url(#{uid})" /><path
				d={path}
				stroke="#b1c7ee"
				stroke-width="2"
				fill="none"
			/></svg
		>
		{#each points as point, index (index)}<button
				class="curve-point"
				class:selected={selected === index}
				style="left:{((8 + point.x * 244) / 260) * 100}%;top:{((104 - point.y * 96) / 112) * 100}%"
				aria-label="Point {index + 1}, input {point.x.toFixed(2)}, output {point.y.toFixed(
					2
				)}. Arrow keys move; Delete removes."
				onpointerdown={(event) => start(event, index)}
				onpointermove={move}
				onpointerup={() => (drag = null)}
				onpointercancel={() => (drag = null)}
				onlostpointercapture={() => (drag = null)}
				onfocus={() => (selected = index)}
				ondblclick={() => remove(index)}
				onkeydown={(event) => key(event, index)}
			></button>{/each}
	</div>
	<div class="curve-footer">
		<span>0 <span>metric → response</span> 1</span>
		<div>
			<button aria-label="Add curve point" onclick={() => add()} disabled={points.length >= 32}
				>+</button
			><button
				aria-label="Remove selected curve point"
				onclick={() => remove()}
				disabled={!points[selected] ||
					points[selected].x === 0 ||
					points[selected].x === 1 ||
					points.length <= 2}>−</button
			>
		</div>
	</div>
</div>
