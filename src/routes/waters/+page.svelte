<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import { waters, loadWaters, seedWaters, addWater, removeWater } from '#lib/stores/waters.svelte.js';
	import WatersMap from '#lib/components/waters/WatersMap.svelte';
	import GaugeTile from '#lib/components/waters/GaugeTile.svelte';
	import LakeTile from '#lib/components/waters/LakeTile.svelte';
	import GaugeThumb from '#lib/components/waters/GaugeThumb.svelte';

	let { data }: { data: PageData } = $props();
	const t = data.t;

	// svelte-ignore state_referenced_locally
	seedWaters(data.gauges);

	type FoundLake = {
		siteId: string; name: string; kind: 'lake' | 'reservoir' | 'pond'; state: string | null; county: string | null;
		lat: number | null; lng: number | null; areaKm2: number | null; saved: boolean;
	};
	type Found = {
		siteId: string; number: string; name: string; river: string; state: string | null; lat: number | null; lng: number | null; saved: boolean;
		latest: { discharge: { value: number; time: string } | null; stage: { value: number; time: string } | null };
	};

	let query = $state('');
	let searching = $state(false);
	let results = $state<Found[] | null>(null);
	let lakes = $state<FoundLake[]>([]);
	let lakesTruncated = $state(false);
	let partial = $state<'gauges' | 'lakes' | null>(null);
	let truncated = $state(false);
	let message = $state<string | null>(null);
	let busy = $state<Record<string, boolean>>({});

	const atLimit = $derived(waters.gauges.length >= data.max);

	onMount(() => { loadWaters(); });

	function errorText(status: number, code?: string) {
		if (code === 'too_many') return t.watersTooMany;
		if (code === 'invalid') return t.watersInvalidQuery;
		if (code === 'limit') return t.watersLimit;
		if (status === 429) return t.watersRateLimited;
		if (status === 503) return t.watersUnavailable;
		return t.watersSaveFailed;
	}

	async function search(e: SubmitEvent) {
		e.preventDefault();
		if (searching) return;
		searching = true;
		message = null;
		try {
			const res = await fetch('/api/waters/search?q=' + encodeURIComponent(query.trim()));
			const body = await res.json().catch(() => ({}));
			if (!res.ok) { results = null; message = errorText(res.status, body.error); return; }
			results = body.gauges ?? [];
			lakes = body.waterbodies ?? [];
			truncated = !!body.truncated;
			lakesTruncated = !!body.waterbodiesTruncated;
			partial = body.partial ?? null;
		} catch {
			results = null;
			message = t.watersUnavailable;
		} finally {
			searching = false;
		}
	}

	async function follow(g: { siteId: string; saved: boolean }) {
		busy[g.siteId] = true;
		message = null;
		try {
			const res = await fetch('/api/waters', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ siteId: g.siteId })
			});
			const body = await res.json().catch(() => ({}));
			if (res.status === 201 || res.status === 409) {
				if (res.status === 201) addWater(body.gauge);
				selected = null;
				g.saved = true;
				loadWaters(true);
			} else {
				message = errorText(res.status, body.error);
			}
		} catch {
			message = t.watersSaveFailed;
		} finally {
			busy[g.siteId] = false;
		}
	}

	async function remove(id: string, siteId: string) {
		busy[siteId] = true;
		try {
			const res = await fetch('/api/waters/' + id, { method: 'DELETE' });
			if (res.ok) {
				removeWater(id);
				selected = null;
				const hit = results?.find((r) => r.siteId === siteId) ?? lakes.find((r) => r.siteId === siteId);
				if (hit) hit.saved = false;
			}
		} finally {
			busy[siteId] = false;
		}
	}

	const fmtFlow = (v: number) => Math.round(v).toLocaleString();
	const fmtStage = (v: number) => v.toFixed(2);
	const kindName = (k: FoundLake['kind']) => (k === 'reservoir' ? t.watersKindReservoir : k === 'pond' ? t.watersKindPond : t.watersKindLake);
	const acres = (km2: number) => Math.round(km2 * 247.105).toLocaleString();

	// The gauge the map is snapped to; null = frame every followed gauge.
	let selected = $state<string | null>(null);

	const card = 'background:var(--of-bg-surface); border:1px solid var(--of-border-subtle); border-radius:14px; padding:18px;';
	const btn = 'font-size:0.8rem; font-weight:600; padding:7px 14px; border-radius:9px; cursor:pointer;';
	const primary = btn + 'color:var(--of-accent); background:var(--of-accent-glow); border:1px solid var(--of-accent-border);';
</script>

<div style="display:flex; flex-direction:column; gap:20px;">
	<h1 style="font-size:1.25rem; font-weight:700; color:var(--of-text); margin:0;">{t.watersTitle}</h1>

	<!-- Search -->
	<form onsubmit={search} style="{card} display:flex; flex-direction:column; gap:10px;">
		<label for="river-q" style="font-size:0.68rem; font-weight:500; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em;">{t.watersSearchLabel}</label>
		<div style="display:flex; gap:8px; flex-wrap:wrap;">
			<input id="river-q" type="search" bind:value={query} placeholder={t.watersSearchPlaceholder} maxlength="40" autocomplete="off"
				style="flex:1; min-width:180px; padding:9px 12px; border-radius:9px; border:1px solid var(--of-border-subtle); background:var(--of-bg); color:var(--of-text); font-size:0.9rem;" />
			<button type="submit" disabled={searching || query.trim().length < 3} style="{primary} opacity:{searching || query.trim().length < 3 ? 0.5 : 1};">
				{searching ? t.watersSearching : t.watersSearchBtn}
			</button>
		</div>
		{#if results === null && !message}
			<p style="margin:0; font-size:0.8rem; color:var(--of-text-4);">{t.watersHint}</p>
		{/if}
		{#if message}
			<p role="alert" style="margin:0; font-size:0.82rem; color:var(--of-text-2);">{message}</p>
		{/if}
	</form>

	<!-- Search results -->
	{#if results !== null}
		<section style="{card} display:flex; flex-direction:column; gap:4px; max-height:420px; overflow-y:auto; overscroll-behavior:contain;" aria-label={t.watersFoundHeading}>
			{#if partial === 'lakes'}<p style="margin:0 0 6px; font-size:0.78rem; color:var(--of-text-3);" data-testid="partial-lakes">{t.watersLakesUnavailable}</p>{/if}
			{#if partial === 'gauges'}<p style="margin:0 0 6px; font-size:0.78rem; color:var(--of-text-3);" data-testid="partial-gauges">{t.watersGaugesUnavailable}</p>{/if}
			{#if results.length === 0 && lakes.length === 0}
				<p style="margin:0; font-size:0.85rem; color:var(--of-text-3);">{t.watersNoResults}</p>
			{:else}
				{#if results.length && lakes.length}<h2 style="margin:0 0 4px; font-size:0.7rem; font-weight:700; color:var(--of-text-3); text-transform:uppercase; letter-spacing:0.08em;">{t.watersGaugesHeading}</h2>{/if}
				{#each results as g, i (g.siteId)}
					{#if i === 0 || results[i - 1].river !== g.river}
						<h2 style="margin:{i ? '14px' : '0'} 0 4px; font-size:0.72rem; font-weight:600; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em;">
							{g.river}{g.state ? ` · ${g.state}` : ''}
						</h2>
					{/if}
					<div style="display:flex; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--of-border-subtle);">
						<GaugeThumb lat={g.lat} lng={g.lng} size={56} alt={t.watersThumbAlt} />
						<div style="flex:1; min-width:0;">
							<div style="font-size:0.85rem; color:var(--of-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{g.name}</div>
							<div style="font-size:0.72rem; color:var(--of-text-4); font-family:'JetBrains Mono',monospace;">
								{g.number}
								{#if g.latest.discharge} · {fmtFlow(g.latest.discharge.value)} cfs{/if}
								{#if g.latest.stage} · {fmtStage(g.latest.stage.value)} ft{/if}
							</div>
						</div>
						{#if g.saved}
							<span style="font-size:0.78rem; color:var(--of-accent); font-weight:600;">✓ {t.watersFollowing}</span>
						{:else}
							<button type="button" onclick={() => follow(g)} disabled={busy[g.siteId] || atLimit}
								title={atLimit ? t.watersLimit : ''} style="{primary} opacity:{busy[g.siteId] || atLimit ? 0.5 : 1};">{t.watersFollow}</button>
						{/if}
					</div>
				{/each}
				{#if truncated}
					<p style="margin:10px 0 0; font-size:0.78rem; color:var(--of-text-4);">{t.watersTruncated}</p>
				{/if}
				{#if lakes.length}
					<h2 style="margin:{results.length ? '18px' : '0'} 0 4px; font-size:0.7rem; font-weight:700; color:var(--of-text-3); text-transform:uppercase; letter-spacing:0.08em;" data-testid="lakes-heading">{t.watersLakesHeading}</h2>
					{#each lakes as w (w.siteId)}
						<div data-testid="lake-result" style="display:flex; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--of-border-subtle);">
							<GaugeThumb lat={w.lat} lng={w.lng} size={56} alt={t.watersThumbAlt} />
							<div style="flex:1; min-width:0;">
								<div style="font-size:0.85rem; color:var(--of-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{w.name}</div>
								<div style="font-size:0.72rem; color:var(--of-text-4);">
									{kindName(w.kind)}{w.county ? ` · ${w.county}` : ''}{w.state ? ` · ${w.state}` : ''}{w.areaKm2 ? ` · ${acres(w.areaKm2)} ${t.watersAcres}` : ''}
								</div>
							</div>
							{#if w.saved}
								<span style="font-size:0.78rem; color:var(--of-accent); font-weight:600;">✓ {t.watersFollowing}</span>
							{:else}
								<button type="button" onclick={() => follow(w)} disabled={busy[w.siteId] || atLimit}
									title={atLimit ? t.watersLimit : ''} style="{primary} opacity:{busy[w.siteId] || atLimit ? 0.5 : 1};">{t.watersFollow}</button>
							{/if}
						</div>
					{/each}
					{#if lakesTruncated}<p style="margin:10px 0 0; font-size:0.78rem; color:var(--of-text-4);">{t.watersTruncated}</p>{/if}
				{/if}
			{/if}
		</section>
	{/if}

	<!-- Map of followed gauges -->
	<section aria-label={t.watersMapHeading}>
		<WatersMap gauges={waters.gauges} {t} selectedId={selected} onselect={(id) => (selected = id)} />
	</section>

	<!-- Followed gauges -->
	{#if waters.gauges.length === 0}
		<div style="{card} text-align:center; padding:48px 24px;">
			<p style="margin:0; font-size:0.875rem; color:var(--of-text-4);">{t.watersEmpty}</p>
		</div>
	{:else}
		{#if waters.stale}
			<p style="margin:0; font-size:0.78rem; color:var(--of-text-4);">{t.watersStale}</p>
		{/if}
		<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:14px;">
			{#each waters.gauges as g (g.id)}
				{#if g.kind === 'gauge'}
				<GaugeTile weather={waters.weather[g.id]} weatherLoading={!waters.weatherLoaded} {g} {t} pending={!waters.loaded || waters.loading} busy={!!busy[g.siteId]} selected={selected === g.id} onselect={() => (selected = selected === g.id ? null : g.id)} onremove={() => remove(g.id, g.siteId)} />
				{:else}
				<LakeTile {g} {t} weather={waters.weather[g.id]} weatherLoading={!waters.weatherLoaded} busy={!!busy[g.siteId]} selected={selected === g.id} onselect={() => (selected = selected === g.id ? null : g.id)} onremove={() => remove(g.id, g.siteId)} />
				{/if}
			{/each}
		</div>
	{/if}
</div>
