<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import { waters, loadWaters, seedWaters, addWater, removeWater } from '#lib/stores/waters.svelte.js';

	let { data }: { data: PageData } = $props();
	const t = data.t;

	// svelte-ignore state_referenced_locally
	seedWaters(data.gauges);

	type Found = {
		siteId: string; number: string; name: string; river: string; state: string | null; saved: boolean;
		latest: { discharge: { value: number; time: string } | null; stage: { value: number; time: string } | null };
	};

	let query = $state('');
	let searching = $state(false);
	let results = $state<Found[] | null>(null);
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
			results = body.gauges;
			truncated = body.truncated;
		} catch {
			results = null;
			message = t.watersUnavailable;
		} finally {
			searching = false;
		}
	}

	async function follow(g: Found) {
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
				const hit = results?.find((r) => r.siteId === siteId);
				if (hit) hit.saved = false;
			}
		} finally {
			busy[siteId] = false;
		}
	}

	const fmtFlow = (v: number) => Math.round(v).toLocaleString();
	const fmtStage = (v: number) => v.toFixed(2);
	const fmtTime = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const trendLabel = (tr: string | null) => (tr === 'rising' ? t.watersRising : tr === 'falling' ? t.watersFalling : tr === 'steady' ? t.watersSteady : '');
	const trendArrow = (tr: string | null) => (tr === 'rising' ? '▲' : tr === 'falling' ? '▼' : tr === 'steady' ? '►' : '');
	const trendColor = (tr: string | null) => (tr === 'rising' ? 'var(--of-accent)' : 'var(--of-text-3)');

	/** Polyline + area path for a series, scaled to a 300×70 box. */
	function chart(points: [number, number][]) {
		const W = 300, H = 70, pad = 4;
		const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
		const x0 = Math.min(...xs), x1 = Math.max(...xs);
		let y0 = Math.min(...ys), y1 = Math.max(...ys);
		if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
		const px = (x: number) => (x1 === x0 ? W / 2 : ((x - x0) / (x1 - x0)) * W);
		const py = (y: number) => H - pad - ((y - y0) / (y1 - y0)) * (H - pad * 2);
		const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join('');
		return { line, area: `${line}L${px(x1).toFixed(1)},${H}L${px(x0).toFixed(1)},${H}Z`, W, H };
	}

	const card = 'background:var(--of-bg-surface); border:1px solid var(--of-border-subtle); border-radius:14px; padding:18px;';
	const btn = 'font-size:0.8rem; font-weight:600; padding:7px 14px; border-radius:9px; cursor:pointer;';
	const primary = btn + 'color:var(--of-accent); background:var(--of-accent-glow); border:1px solid var(--of-accent-border);';
	const quiet = btn + 'color:var(--of-text-3); background:transparent; border:1px solid var(--of-border-subtle);';
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
		<section style="{card} display:flex; flex-direction:column; gap:4px;" aria-label={t.watersFoundHeading}>
			{#if results.length === 0}
				<p style="margin:0; font-size:0.85rem; color:var(--of-text-3);">{t.watersNoResults}</p>
			{:else}
				{#each results as g, i (g.siteId)}
					{#if i === 0 || results[i - 1].river !== g.river}
						<h2 style="margin:{i ? '14px' : '0'} 0 4px; font-size:0.72rem; font-weight:600; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em;">
							{g.river}{g.state ? ` · ${g.state}` : ''}
						</h2>
					{/if}
					<div style="display:flex; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--of-border-subtle);">
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
			{/if}
		</section>
	{/if}

	<!-- Followed gauges -->
	{#if waters.gauges.length === 0}
		<div style="{card} text-align:center; padding:48px 24px;">
			<p style="margin:0; font-size:0.875rem; color:var(--of-text-4);">{t.watersEmpty}</p>
		</div>
	{:else}
		{#if waters.stale}
			<p style="margin:0; font-size:0.78rem; color:var(--of-text-4);">{t.watersStale}</p>
		{/if}
		<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(290px, 1fr)); gap:14px;">
			{#each waters.gauges as g (g.id)}
				{@const main = g.latest?.discharge ?? g.latest?.stage ?? null}
				{@const c = g.series && g.series.points.length >= 2 ? chart(g.series.points) : null}
				<article style={card} data-testid="water-tile">
					<header style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
						<div style="min-width:0;">
							<h2 style="margin:0; font-size:0.9rem; font-weight:600; color:var(--of-text); overflow-wrap:anywhere;">{g.name}</h2>
							<div style="font-size:0.72rem; color:var(--of-text-4); margin-top:2px;">{g.river ?? ''}{g.state ? ` · ${g.state}` : ''}</div>
						</div>
						<button type="button" onclick={() => remove(g.id, g.siteId)} disabled={busy[g.siteId]} aria-label={t.watersRemove} title={t.watersRemove}
							style="{quiet} padding:3px 9px; line-height:1;">✕</button>
					</header>

					{#if (!waters.loaded || waters.loading) && !g.latest}
						<p style="margin:18px 0 6px; font-size:0.8rem; color:var(--of-text-4);">{waters.failed && !waters.loading ? t.watersUnavailable : t.watersRefreshing}</p>
					{:else if !main}
						<p style="margin:18px 0 6px; font-size:0.8rem; color:var(--of-text-4);">{t.watersNoReading}</p>
					{:else}
						<div style="display:flex; gap:22px; margin-top:14px; align-items:flex-end; flex-wrap:wrap;">
							{#if g.latest?.discharge}
								<div>
									<div style="font-size:0.66rem; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em;">{t.watersFlow}</div>
									<div style="font-family:'JetBrains Mono',monospace; font-size:1.5rem; font-weight:600; color:var(--of-text);">
										{fmtFlow(g.latest.discharge.value)}<span style="font-size:0.75rem; color:var(--of-text-3);"> cfs</span>
									</div>
								</div>
							{/if}
							{#if g.latest?.stage}
								<div>
									<div style="font-size:0.66rem; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em;">{t.watersStage}</div>
									<div style="font-family:'JetBrains Mono',monospace; font-size:{g.latest.discharge ? '1.1rem' : '1.5rem'}; font-weight:600; color:var(--of-text);">
										{fmtStage(g.latest.stage.value)}<span style="font-size:0.75rem; color:var(--of-text-3);"> ft</span>
									</div>
								</div>
							{/if}
							{#if g.trend}
								<div style="font-size:0.78rem; font-weight:600; color:{trendColor(g.trend)};">{trendArrow(g.trend)} {trendLabel(g.trend)}</div>
							{/if}
						</div>
						<div style="margin-top:4px; font-size:0.7rem; color:var(--of-text-4);">{t.watersUpdated} {fmtTime(main.time)}</div>
					{/if}

					{#if c}
						<svg viewBox="0 0 {c.W} {c.H}" preserveAspectRatio="none" role="img" aria-label={t.watersLast24h}
							style="width:100%; height:70px; margin-top:12px; display:block;">
							<path d={c.area} fill="var(--of-accent-glow)" />
							<path d={c.line} fill="none" stroke="var(--of-accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
						</svg>
						<div style="font-size:0.66rem; color:var(--of-text-4); margin-top:2px;">{t.watersLast24h}</div>
					{/if}

					<a href={g.usgsUrl} target="_blank" rel="noopener noreferrer"
						style="display:inline-block; margin-top:10px; font-size:0.74rem; color:var(--of-text-3);">{t.watersViewUsgs} ↗</a>
				</article>
			{/each}
		</div>
	{/if}
</div>
