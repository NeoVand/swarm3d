<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { CURATED_SCENES, type SceneDefinition, type SavedScene } from '#lib/model';
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	import SceneArtwork from './SceneArtwork.svelte';
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
		onsave: (name: string, copy: boolean) => Promise<boolean>;
		ondelete: (record: SavedScene) => void;
		onrename: (record: SavedScene, name: string) => Promise<boolean>;
		onexport: () => void;
		onimport: (text: string) => void;
		onshare: () => void;
		ondiscover: () => void;
		onclose: () => void;
		notification?: Snippet;
		saving?: boolean;
	} = $props();
	const uid = $props.id();
	let tab = $state<'explore' | 'saved'>('explore');
	let query = $state('');
	let draftName = $state<string | undefined>(undefined);
	let renaming = $state<string | null>(null);
	let renameDraft = $state('');
	let saveName = $derived(draftName ?? scene.name);
	let search = $derived(query.trim().toLocaleLowerCase());
	let curated = $derived(
		CURATED_SCENES.filter((item) =>
			`${item.name} ${item.description} ${item.world.shape} ${item.world.kind}`
				.toLocaleLowerCase()
				.includes(search)
		)
	);
	let records = $derived(
		saved.filter((record) =>
			`${record.name} ${record.scene.world.shape} ${record.scene.world.kind}`
				.toLocaleLowerCase()
				.includes(search)
		)
	);
	function population(value: SceneDefinition) {
		return value.species.reduce((sum, species) => sum + species.population, 0).toLocaleString();
	}
	async function save(copy = false) {
		if (saving || !saveName.trim()) return;
		const submittedDraft = draftName;
		const pending = onsave(saveName.trim(), copy);
		tab = 'saved';
		query = '';
		if ((await pending) && draftName === submittedDraft) draftName = undefined;
	}
	async function importFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) onimport(await file.text());
		input.value = '';
	}
	async function focusRecord(recordId: string) {
		await tick();
		const target =
			document.getElementById(`${uid}-rename-action-${recordId}`) ??
			document.getElementById(search ? `${uid}-search` : `${uid}-name`);
		if (target instanceof HTMLElement) target.focus({ preventScroll: true });
		return target;
	}
	async function finishRename(record: SavedScene, restoreFocus = false) {
		if (renaming !== record.id) return;
		const name = renameDraft.trim();
		const submittedDraft = draftName;
		const reflectsCurrentName =
			record.scene.id === scene.id &&
			(submittedDraft === undefined || submittedDraft === record.name);
		renaming = null;
		const pending = name && name !== record.name ? onrename(record, name) : Promise.resolve(false);
		const focused = restoreFocus ? await focusRecord(record.id) : null;
		const success = await pending;
		if (success && reflectsCurrentName && draftName === submittedDraft) draftName = undefined;
		if (
			restoreFocus &&
			focused &&
			!focused.isConnected &&
			(document.activeElement === document.body ||
				document.activeElement instanceof HTMLDialogElement)
		)
			await focusRecord(record.id);
	}
	async function cancelRename(record: SavedScene) {
		renaming = null;
		await focusRecord(record.id);
	}
	async function beginRename(record: SavedScene) {
		renameDraft = record.name;
		renaming = record.id;
		await tick();
		const input = document.getElementById(`${uid}-rename`);
		if (input instanceof HTMLInputElement) {
			input.focus();
			input.select();
		}
	}
</script>

<Modal title="Scenes" {onclose} notice={notification} wide>
	<div class="collection-rail">
		<div class="collection-tabs" role="group" aria-label="Scene collection">
			<button
				type="button"
				class:active={tab === 'explore'}
				aria-pressed={tab === 'explore'}
				onclick={() => {
					tab = 'explore';
					renaming = null;
				}}>Explore <span>{CURATED_SCENES.length}</span></button
			>
			<button
				type="button"
				class:active={tab === 'saved'}
				aria-pressed={tab === 'saved'}
				onclick={() => {
					tab = 'saved';
					renaming = null;
				}}>Saved <span>{saved.length}</span></button
			>
		</div>
		<label class="collection-search">
			<svg
				viewBox="0 0 20 20"
				width="13"
				height="13"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				aria-hidden="true"><circle cx="8" cy="8" r="4.8" /><path d="m12 12 4 4" /></svg
			>
			<input
				id={`${uid}-search`}
				type="search"
				aria-label="Search scenes"
				placeholder="Find a scene"
				bind:value={query}
			/>
		</label>
		<button
			class="discover-button"
			type="button"
			onclick={ondiscover}
			title="Discover a new seeded scene"
			><Icon name="dice" size={15} /><span>Discover</span></button
		>
	</div>
	<div class="collection-grid">
		{#if tab === 'explore'}
			{#each curated as item (item.id)}
				<button
					class="collection-scene"
					class:current={scene.id === item.id}
					type="button"
					aria-label={`Load ${item.name}`}
					title={item.description}
					onclick={() => onload(item)}
				>
					<div class="collection-art">
						<SceneArtwork scene={item} />{#if scene.id === item.id}<span class="current-mark"
								><Icon name="check" size={11} /></span
							>{/if}
					</div>
					<div class="collection-copy">
						<h3>{item.name}</h3>
						<span
							>{item.world.shape}
							{item.world.kind}<span class="meta-dot">·</span>{population(item)}</span
						>
					</div>
				</button>
			{:else}
				<div class="collection-empty">
					<p>No scenes match “{query}”.</p>
					<button type="button" onclick={() => (query = '')}>Clear search</button>
				</div>
			{/each}
		{:else}
			{#each records as record (record.id)}
				<article class="collection-scene saved-scene" class:current={scene.id === record.scene.id}>
					<button
						type="button"
						class="saved-art"
						aria-label={`Load ${record.name}`}
						onclick={() => onload(record.scene)}
						><SceneArtwork scene={record.scene} thumbnail={record.thumbnail} /></button
					>
					<div class="collection-copy">
						{#if renaming === record.id}
							<form
								onsubmit={(event) => {
									event.preventDefault();
									void finishRename(record, true);
								}}
							>
								<input
									id={`${uid}-rename`}
									class="rename-input"
									aria-label={`Rename ${record.name}`}
									bind:value={renameDraft}
									maxlength="120"
									onblur={() => void finishRename(record)}
									onkeydown={(event) => {
										if (event.key === 'Escape') {
											event.preventDefault();
											event.stopPropagation();
											void cancelRename(record);
										}
									}}
								/>
							</form>
						{:else}<h3>
								<button class="saved-name" type="button" onclick={() => onload(record.scene)}
									>{record.name}</button
								>
							</h3>{/if}
						<span
							>{record.scene.world.shape}
							{record.scene.world.kind}<span class="meta-dot">·</span>{population(
								record.scene
							)}</span
						>
						<div class="record-actions">
							<button
								id={`${uid}-rename-action-${record.id}`}
								type="button"
								aria-label={`Rename ${record.name}`}
								title="Rename scene"
								onclick={() => void beginRename(record)}><Icon name="pencil" size={12} /></button
							><button
								type="button"
								aria-label={`Delete ${record.name}`}
								title="Delete scene"
								onclick={() => ondelete(record)}><Icon name="trash" size={12} /></button
							>
						</div>
					</div>
				</article>
			{:else}
				<div class="collection-empty">
					{#if search}<p>No saved scenes match “{query}”.</p>
						<button type="button" onclick={() => (query = '')}>Clear search</button>{:else}<Icon
							name="save"
							size={22}
						/>
						<p>Keep a good discovery.</p>
						<span>Save the settings and view of your current scene.</span>{/if}
				</div>
			{/each}
		{/if}
	</div>
	<form
		class="collection-save"
		onsubmit={(event) => {
			event.preventDefault();
			void save();
		}}
	>
		<label for={`${uid}-name`}>Current scene</label>
		<div class="collection-save-row">
			<input
				id={`${uid}-name`}
				aria-label="Scene name"
				value={saveName}
				maxlength="120"
				oninput={(event) => (draftName = event.currentTarget.value)}
			/><button class="save-button" type="submit" disabled={saving || !saveName.trim()}
				><Icon name="save" size={13} />{saving ? 'Saving…' : 'Save'}</button
			><button
				class="copy-button"
				type="button"
				title="Save a new copy"
				aria-label="Save a new copy"
				disabled={saving || !saveName.trim()}
				onclick={() => void save(true)}><Icon name="plus" size={15} /></button
			>
		</div>
	</form>
	<footer class="collection-footer">
		<span>Settings, seed & view</span>
		<div>
			<button type="button" onclick={onshare}><Icon name="share" size={12} />Share</button><button
				type="button"
				onclick={onexport}><Icon name="export" size={12} />Export</button
			><button type="button" onclick={() => document.getElementById(`${uid}-import`)?.click()}
				><Icon name="import" size={12} />Import</button
			>
		</div>
	</footer>
	<input
		id={`${uid}-import`}
		type="file"
		accept="application/json,.json"
		aria-label="Import scene file"
		onchange={importFile}
		hidden
	/>
</Modal>

<style>
	.collection-rail {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 15px;
	}
	.collection-tabs {
		display: flex;
		flex: none;
		align-items: center;
		gap: 4px;
	}
	.collection-tabs button {
		display: flex;
		align-items: center;
		gap: 5px;
		height: 29px;
		padding: 0 9px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.collection-tabs button.active {
		background: color-mix(in srgb, var(--lilac) 7%, transparent);
		color: var(--lilac);
	}
	.collection-tabs button span {
		color: var(--faint);
		font-size: 9px;
	}
	.collection-tabs button.active span {
		color: var(--lilac);
	}
	.collection-search {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 60px;
		height: 29px;
		padding: 0 8px;
		color: var(--faint);
		border: 1px solid var(--line);
		border-radius: 6px;
		background: color-mix(in srgb, var(--ink) 1.2%, transparent);
	}
	.collection-search input {
		width: 100%;
		min-width: 0;
		padding: 0;
		border: 0;
		outline: 0;
		color: var(--pearl);
		background: transparent;
		font: inherit;
		font-size: 10px;
	}
	.collection-search:focus-within {
		border-color: color-mix(in srgb, var(--lilac) 40%, transparent);
	}
	.collection-search input::placeholder {
		color: var(--faint);
	}
	.discover-button {
		display: flex;
		align-items: center;
		flex: none;
		gap: 5px;
		padding: 6px 2px;
		border: 0;
		background: transparent;
		color: var(--amber);
		font: inherit;
		font-size: 10px;
		cursor: pointer;
	}
	.collection-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 17px 12px;
		max-height: 360px;
		min-height: 180px;
		overflow: auto;
		scrollbar-width: thin;
		scrollbar-color: color-mix(in srgb, var(--lilac) 19%, transparent) transparent;
		padding: 2px 1px 10px;
	}
	.collection-scene {
		position: relative;
		display: block;
		align-self: start;
		min-width: 0;
		padding: 0;
		border: 0;
		border-radius: 0;
		color: var(--pearl);
		background: transparent;
		text-align: left;
		font: inherit;
		cursor: pointer;
	}
	.collection-art,
	.saved-art {
		position: relative;
		display: block;
		width: 100%;
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--inset);
		transition: border-color 0.15s;
	}
	.collection-scene:hover .collection-art,
	.collection-scene:hover .saved-art {
		border-color: color-mix(in srgb, var(--lilac) 40%, transparent);
	}
	.collection-scene.current .collection-art,
	.collection-scene.current .saved-art {
		border-color: color-mix(in srgb, var(--lilac) 27%, transparent);
	}
	.current-mark {
		position: absolute;
		right: 7px;
		bottom: 7px;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border: 1px solid color-mix(in srgb, var(--lilac) 25%, transparent);
		border-radius: 50%;
		color: var(--lilac);
		background: var(--popover);
	}
	.collection-copy {
		position: relative;
		padding: 7px 1px 0;
	}
	.collection-copy h3 {
		margin: 0 0 3px;
		color: var(--pearl);
		font-size: 11px;
		font-weight: 550;
		line-height: 1.4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.collection-copy > span {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--muted);
		font-size: 9px;
		line-height: 1.5;
		text-transform: capitalize;
	}
	.meta-dot {
		color: var(--faint);
	}
	.saved-art {
		cursor: pointer;
	}
	.saved-name {
		display: block;
		width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0 34px 0 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.record-actions {
		position: absolute;
		display: flex;
		gap: 1px;
		right: -2px;
		top: 6px;
		opacity: 0.35;
	}
	.record-actions button {
		display: grid;
		place-items: center;
		width: 19px;
		height: 22px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.saved-scene:hover .record-actions,
	.saved-scene:focus-within .record-actions {
		opacity: 1;
	}
	.record-actions button:hover {
		background: color-mix(in srgb, var(--ink) 3%, transparent);
		color: var(--lilac);
	}
	.record-actions button:last-child:hover {
		color: var(--rose);
	}
	.rename-input {
		box-sizing: border-box;
		width: 100%;
		height: 24px;
		margin-bottom: 3px;
		padding: 2px 5px;
		border: 1px solid color-mix(in srgb, var(--lilac) 25%, transparent);
		border-radius: 4px;
		background: var(--popover);
		color: var(--pearl);
		font: inherit;
		font-size: 11px;
	}
	.collection-empty {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 32px 16px;
		color: var(--lilac);
		text-align: center;
	}
	.collection-empty p {
		margin: 10px 0 6px;
		color: var(--pearl);
		font-size: 12px;
	}
	.collection-empty span {
		color: var(--muted);
		font-size: 11px;
	}
	.collection-empty button {
		margin-top: 8px;
		border: 0;
		background: transparent;
		color: var(--lilac);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.collection-save {
		padding-top: 12px;
		border-top: 1px solid var(--line);
	}
	.collection-save > label {
		display: block;
		margin-bottom: 6px;
		color: var(--muted);
		font-size: 10px;
	}
	.collection-save-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.collection-save-row input {
		box-sizing: border-box;
		min-width: 0;
		flex: 1;
		height: 30px;
		padding: 5px 8px;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: color-mix(in srgb, var(--ink) 1.2%, transparent);
		color: var(--pearl);
		font: inherit;
		font-size: 11px;
	}
	.save-button,
	.copy-button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		height: 30px;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--lilac) 15%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--lilac) 7%, transparent);
		color: var(--lilac);
		font: inherit;
		font-size: 10px;
		cursor: pointer;
	}
	.copy-button {
		width: 30px;
		padding: 0;
		background: transparent;
		color: var(--muted);
	}
	.save-button:disabled,
	.copy-button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.collection-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding-top: 12px;
	}
	.collection-footer > span {
		color: var(--faint);
		font-size: 9px;
	}
	.collection-footer > div {
		display: flex;
		align-items: center;
		gap: 15px;
	}
	.collection-footer button {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 0;
		border: 0;
		background: transparent;
		color: var(--muted);
		font: inherit;
		font-size: 10px;
		cursor: pointer;
	}
	.collection-footer button:hover {
		color: var(--lilac);
	}
	button:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--lilac);
		outline-offset: 3px;
	}
	.collection-search input:focus-visible {
		outline: 0;
	}
	@media (max-width: 540px) {
		.collection-rail {
			flex-wrap: wrap;
			gap: 8px;
		}
		.collection-tabs {
			flex: 1;
		}
		.collection-search {
			order: 3;
			flex-basis: 100%;
		}
		.collection-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			max-height: 340px;
			gap: 15px 11px;
		}
		.collection-footer > div {
			gap: 12px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.collection-art,
		.saved-art {
			transition: none;
		}
	}
</style>
