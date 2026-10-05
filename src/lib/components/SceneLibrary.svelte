<script lang="ts">
	import type { Snippet } from 'svelte';
	import { CURATED_SCENES, type SceneDefinition, type SavedScene } from '#lib/model';
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	let {
		scene,
		saved,
		onload,
		onsave,
		ondelete,
		onrename,
		onexport,
		onimport,
		onshare,
		ondiscover,
		onclose,
		notification,
		saving = false
	}: {
		scene: SceneDefinition;
		saved: SavedScene[];
		onload: (scene: SceneDefinition) => void;
		onsave: (name: string, copy: boolean) => void;
		ondelete: (record: SavedScene) => void;
		onrename: (record: SavedScene, name: string) => void;
		onexport: () => void;
		onimport: (text: string) => void;
		onshare: () => void;
		ondiscover: () => void;
		onclose: () => void;
		notification?: Snippet;
		saving?: boolean;
	} = $props();
	let tab = $state<'explore' | 'saved'>('explore');
	let draftName = $state('');
	let renaming = $state<string | null>(null);
	const uid = $props.id();
	function color(value: SceneDefinition, index: number) {
		const hsl = value.species[index % value.species.length].visual.hsl;
		return `hsl(${hsl[0] * 360} ${hsl[1] * 100}% ${hsl[2] * 100}%)`;
	}
	function population(value: SceneDefinition) {
		return value.species.reduce((sum, species) => sum + species.population, 0).toLocaleString();
	}
	async function importFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) onimport(await file.text());
		input.value = '';
	}
</script>

<Modal
	title="A world of possibilities"
	subtitle="Start with a scene. Make it your own."
	{onclose}
	notice={notification}
	wide
>
	<div class="save-current">
		<div>
			<span class="eyebrow">KEEP THIS DISCOVERY</span><label class="sr-only" for={uid}
				>Scene name</label
			><input
				id={uid}
				value={draftName || scene.name}
				maxlength="120"
				oninput={(event) => (draftName = event.currentTarget.value)}
				onkeydown={(event) => {
					if (event.key === 'Enter') onsave(draftName || scene.name, false);
				}}
			/>
		</div>
		<button
			class="primary-button"
			disabled={saving}
			onclick={() => {
				onsave(draftName || scene.name, false);
				tab = 'saved';
			}}><Icon name="save" size={15} />{saving ? 'Saving…' : 'Save'}</button
		><button
			class="icon-button"
			title="Save a new copy"
			aria-label="Save a new copy"
			disabled={saving}
			onclick={() => {
				onsave(draftName || scene.name, true);
				tab = 'saved';
			}}><Icon name="plus" size={17} /></button
		>
	</div>
	<div class="library-toolbar">
		<div class="segmented">
			<button
				class:active={tab === 'explore'}
				aria-pressed={tab === 'explore'}
				onclick={() => (tab = 'explore')}>Explore</button
			><button
				class:active={tab === 'saved'}
				aria-pressed={tab === 'saved'}
				onclick={() => (tab = 'saved')}>Saved <span>{saved.length}</span></button
			>
		</div>
		<button class="text-button" onclick={ondiscover}><Icon name="dice" size={16} />Discover</button>
	</div>
	<div class="scene-grid">
		{#if tab === 'explore'}
			{#each CURATED_SCENES as item (item.id)}<button
					class="scene-card"
					aria-label="Load {item.name}"
					aria-describedby="{uid}-{item.id}-world {uid}-{item.id}-description {uid}-{item.id}-population"
					onclick={() => onload(item)}
					><div
						class="scene-preview"
						class:planet={item.world.shape === 'sphere'}
						class:plane={item.world.shape === 'plane'}
						class:cylinder={item.world.shape === 'cylinder'}
						class:torus={item.world.shape === 'torus'}
						style="--preview-bg:{item.visual.background};--color-a:{color(
							item,
							0
						)};--color-b:{color(item, 1)}"
					>
						<div class="preview-orbit"></div>
						<div class="preview-orbit second"></div>
						<span id="{uid}-{item.id}-world"
							>{item.world.kind.toUpperCase()} / {item.world.shape.toUpperCase()}</span
						>
					</div>
					<div class="scene-card-content">
						<h3>{item.name}<Icon name="chevron" size={14} /></h3>
						<p id="{uid}-{item.id}-description">{item.description}</p>
						<span id="{uid}-{item.id}-population"
							>{population(item)} agents <b>·</b> {item.species.length} species</span
						>
					</div></button
				>{/each}
		{:else if saved.length}
			{#each saved as record (record.id)}<article class="scene-card">
					<button
						class="saved-load"
						aria-label="Load {record.name}"
						onclick={() => onload(record.scene)}
						>{#if record.thumbnail}<img
								class="scene-thumbnail"
								src={record.thumbnail}
								alt="Captured view of {record.name}"
							/>{:else}<div
								class="scene-preview"
								class:planet={record.scene.world.shape === 'sphere'}
								class:plane={record.scene.world.shape === 'plane'}
								class:cylinder={record.scene.world.shape === 'cylinder'}
								class:torus={record.scene.world.shape === 'torus'}
								style="--preview-bg:{record.scene.visual.background};--color-a:{color(
									record.scene,
									0
								)};--color-b:{color(record.scene, 1)}"
							>
								<div class="preview-orbit"></div>
								<div class="preview-orbit second"></div>
								<span
									>{record.scene.world.kind.toUpperCase()} / {record.scene.world.shape.toUpperCase()}</span
								>
							</div>{/if}</button
					>
					<div class="scene-card-content">
						{#if renaming === record.id}<label class="sr-only" for="rename-{record.id}"
								>Rename {record.name}</label
							><input
								id="rename-{record.id}"
								value={record.name}
								maxlength="120"
								onchange={(event) => {
									onrename(record, event.currentTarget.value);
									renaming = null;
								}}
								onkeydown={(event) => {
									if (event.key === 'Escape') renaming = null;
									if (event.key === 'Enter') {
										onrename(record, event.currentTarget.value);
										renaming = null;
									}
								}}
							/>{:else}<h3>
								<button class="saved-name" onclick={() => onload(record.scene)}
									>{record.name}</button
								><button
									class="icon-button compact"
									aria-label="Rename {record.name}"
									onclick={() => (renaming = record.id)}><Icon name="pencil" size={13} /></button
								>
							</h3>{/if}
						<p>
							{population(record.scene)} agents · {record.scene.world.shape}
							{record.scene.world.kind}
						</p>
						<div class="saved-footer">
							<span
								>{new Date(record.updatedAt).toLocaleDateString(undefined, {
									month: 'short',
									day: 'numeric'
								})}</span
							><button
								class="icon-button compact"
								aria-label="Delete {record.name}"
								onclick={() => ondelete(record)}><Icon name="trash" size={14} /></button
							>
						</div>
					</div>
				</article>{/each}
		{:else}<div class="library-empty">
				<Icon name="save" size={30} />
				<h3>Your discoveries live here.</h3>
				<p>Save a scene to keep its settings, seed, obstacles, and camera on this device.</p>
			</div>{/if}
	</div>
	<div class="library-bottom">
		<span class="fine-print">Loading a scene starts a fresh simulation.</span>
		<div>
			<button class="text-button" onclick={onshare}><Icon name="share" size={14} />Share</button
			><button class="text-button" onclick={onexport}><Icon name="export" size={14} />Export</button
			><label class="text-button import-button" for="{uid}-import"
				><Icon name="import" size={14} />Import<input
					id="{uid}-import"
					type="file"
					accept="application/json,.json"
					onchange={importFile}
				/></label
			>
		</div>
	</div>
</Modal>

<style>
	.torus .preview-orbit {
		width: 140px;
		height: 62px;
		left: calc(50% - 70px);
		top: 29px;
		border-width: 10px;
		transform: rotate(-17deg);
	}
	.torus .preview-orbit.second {
		width: 70px;
		height: 30px;
		left: calc(50% - 35px);
		top: 45px;
		border-width: 1px;
		transform: rotate(-17deg);
	}

	.plane .preview-orbit {
		width: 140px;
		height: 65px;
		left: calc(50% - 70px);
		top: 26px;
		border-radius: 2px;
		transform: skewY(-13deg);
	}
	.plane .preview-orbit.second {
		width: 70px;
		left: calc(50% - 35px);
		border-block: 0;
		transform: skewY(-13deg);
	}
	.cylinder .preview-orbit {
		width: 88px;
		height: 75px;
		left: calc(50% - 44px);
		top: 22px;
		border-radius: 50% / 18%;
		transform: rotate(-12deg);
	}
	.cylinder .preview-orbit.second {
		width: 88px;
		height: 28px;
		left: calc(50% - 44px);
		top: 21px;
		transform: rotate(-12deg);
	}
</style>
