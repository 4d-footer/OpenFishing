<script lang="ts">
	import type { Translations } from '#lib/i18n/index.js';
	import type { GaugeView } from '#lib/server/waters.js';
	import type { Forecast } from '#lib/server/forecast.js';
	import { clip, forecastWindows, horizonHours, WINDOWS } from '#lib/waters/geo.js';
	import FlowChart from './FlowChart.svelte';
	import GaugeThumb from './GaugeThumb.svelte';

	let {
		g,
		t,
		pending,
		busy,
		highlight = false,
		onremove
	}: {
		g: GaugeView;
		t: Translations;
		pending: boolean; // first readings still on their way
		busy: boolean;
		highlight?: boolean;
		onremove: () => void;
	} = $props();

	type Series = { param: string; points: [number, number][] } | null;
	type Load<T> = { status: 'loading' | 'ok' | 'error'; value?: T };

	let view = $state<'history' | 'forecast'>('history');
	let hours = $state<number>(24);
	let fcWindow = $state<number | null | undefined>(undefined); // undefined = pick the largest on load
	let hist = $state<Record<number, Load<Series>>>({});
	let fc = $state<Load<Forecast | null> | null>(null);

	const rangeLabel = (h: number | null) =>
		h === 24 ? t.watersRange24 : h === 48 ? t.watersRange48 : h === 72 ? t.watersRange72 : h === 168 ? t.watersRange168 : t.watersForecastAll;
	const unitOf = (param: string | undefined) => (param === '00060' ? 'cfs' : 'ft') as 'cfs' | 'ft';
	const fmtTime = (ms: number | string) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const fmtFlow = (v: number) => Math.round(v).toLocaleString();
	const fmtStage = (v: number) => v.toFixed(2);
	const trendLabel = (tr: string | null) => (tr === 'rising' ? t.watersRising : tr === 'falling' ? t.watersFalling : tr === 'steady' ? t.watersSteady : '');
	const trendArrow = (tr: string | null) => (tr === 'rising' ? '▲' : tr === 'falling' ? '▼' : tr === 'steady' ? '►' : '');

	const main = $derived(g.latest?.discharge ?? g.latest?.stage ?? null);

	async function loadHistory(h: number) {
		if (h === 24 || hist[h]?.status === 'ok' || hist[h]?.status === 'loading') return;
		hist[h] = { status: 'loading' };
		try {
			const res = await fetch(`/api/waters/${g.id}/history?hours=${h}`);
			if (!res.ok) throw new Error(String(res.status));
			hist[h] = { status: 'ok', value: (await res.json()).series };
		} catch {
			hist[h] = { status: 'error' };
		}
	}

	async function loadForecast() {
		if (fc?.status === 'ok' || fc?.status === 'loading') return;
		fc = { status: 'loading' };
		try {
			const res = await fetch(`/api/waters/${g.id}/forecast`);
			if (!res.ok) throw new Error(String(res.status));
			const value = (await res.json()).forecast as Forecast | null;
			fc = { status: 'ok', value };
			if (value && fcWindow === undefined) {
				const opts = forecastWindows(horizonHours(value.points));
				fcWindow = opts[opts.length - 1];
			}
		} catch {
			fc = { status: 'error' };
		}
	}

	function show(v: 'history' | 'forecast') {
		view = v;
		if (v === 'forecast') loadForecast();
		else loadHistory(hours);
	}
	function pickHours(h: number) {
		hours = h;
		loadHistory(h);
	}

	const histSeries = $derived<Series>(hours === 24 ? g.series : (hist[hours]?.value ?? null));
	const histState = $derived(hours === 24 ? (g.series ? 'ok' : pending ? 'loading' : 'ok') : (hist[hours]?.status ?? 'loading'));
	const forecast = $derived(fc?.status === 'ok' ? (fc.value ?? null) : null);
	const windows = $derived(forecast ? forecastWindows(horizonHours(forecast.points)) : []);
	const fcPoints = $derived(forecast ? clip(forecast.points, 'future', fcWindow === undefined ? null : fcWindow) : []);
</script>

<article id="tile-{g.id}" data-testid="water-tile"
	style="background:var(--of-bg-surface); border:1px solid {highlight ? 'var(--of-accent)' : 'var(--of-border-subtle)'}; border-radius:14px; padding:18px; transition:border-color .3s;">
	<header style="display:flex; gap:12px; align-items:flex-start;">
		<GaugeThumb lat={g.lat} lng={g.lng} size={84} alt={t.watersThumbAlt} />
		<div style="flex:1; min-width:0;">
			<h2 style="margin:0; font-size:0.9rem; font-weight:600; color:var(--of-text); overflow-wrap:anywhere;">{g.name}</h2>
			<div style="font-size:0.72rem; color:var(--of-text-4); margin-top:2px;">{g.river ?? ''}{g.state ? ` · ${g.state}` : ''}</div>
			<a href={g.usgsUrl} target="_blank" rel="noopener noreferrer" style="display:inline-block; margin-top:6px; font-size:0.72rem; color:var(--of-text-3);">{t.watersViewUsgs} ↗</a>
		</div>
		<button type="button" onclick={onremove} disabled={busy} aria-label={t.watersRemove} title={t.watersRemove}
			style="font-size:0.8rem; padding:3px 9px; line-height:1; border-radius:9px; cursor:pointer; color:var(--of-text-3); background:transparent; border:1px solid var(--of-border-subtle);">✕</button>
	</header>

	{#if pending && !g.latest}
		<p style="margin:16px 0 4px; font-size:0.8rem; color:var(--of-text-4);">{t.watersRefreshing}</p>
	{:else if !main}
		<p style="margin:16px 0 4px; font-size:0.8rem; color:var(--of-text-4);">{t.watersNoReading}</p>
	{:else}
		<div style="display:flex; gap:22px; margin-top:14px; align-items:flex-end; flex-wrap:wrap;">
			{#if g.latest?.discharge}
				<div>
					<div style="font-size:0.66rem; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em;">{t.watersFlow}</div>
					<div style="font-family:'JetBrains Mono',monospace; font-size:1.5rem; font-weight:600; color:var(--of-text);">{fmtFlow(g.latest.discharge.value)}<span style="font-size:0.75rem; color:var(--of-text-3);"> cfs</span></div>
				</div>
			{/if}
			{#if g.latest?.stage}
				<div>
					<div style="font-size:0.66rem; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em;">{t.watersStage}</div>
					<div style="font-family:'JetBrains Mono',monospace; font-size:{g.latest.discharge ? '1.1rem' : '1.5rem'}; font-weight:600; color:var(--of-text);">{fmtStage(g.latest.stage.value)}<span style="font-size:0.75rem; color:var(--of-text-3);"> ft</span></div>
				</div>
			{/if}
			{#if g.trend}
				<div style="font-size:0.78rem; font-weight:600; color:{g.trend === 'rising' ? 'var(--of-accent)' : 'var(--of-text-3)'};">{trendArrow(g.trend)} {trendLabel(g.trend)}</div>
			{/if}
		</div>
		<div style="margin-top:4px; font-size:0.7rem; color:var(--of-text-4);">{t.watersUpdated} {fmtTime(main.time)}</div>
	{/if}

	<!-- History / Forecast -->
	<div style="margin-top:14px; display:flex; gap:6px; flex-wrap:wrap;" role="tablist">
		{#each [['history', t.watersHistory], ['forecast', t.watersForecast]] as [v, label]}
			<button type="button" role="tab" aria-selected={view === v} onclick={() => show(v as 'history' | 'forecast')} data-testid="tab-{v}"
				style="font-size:0.74rem; font-weight:600; padding:5px 12px; border-radius:9px; cursor:pointer; {view === v ? 'color:var(--of-accent); background:var(--of-accent-glow); border:1px solid var(--of-accent-border);' : 'color:var(--of-text-3); background:transparent; border:1px solid var(--of-border-subtle);'}">{label}</button>
		{/each}
		<span style="flex:1;"></span>
		{#if view === 'history'}
			{#each WINDOWS as h}
				<button type="button" onclick={() => pickHours(h)} aria-pressed={hours === h} data-testid="range-{h}"
					style="font-size:0.72rem; padding:5px 9px; border-radius:8px; cursor:pointer; {hours === h ? 'color:var(--of-text); border:1px solid var(--of-accent);' : 'color:var(--of-text-3); border:1px solid var(--of-border-subtle);'} background:transparent;">{rangeLabel(h)}</button>
			{/each}
		{:else if windows.length > 1 || (windows.length === 1 && windows[0] !== null)}
			{#each windows as w}
				<button type="button" onclick={() => (fcWindow = w)} aria-pressed={fcWindow === w} data-testid="fc-range-{w ?? 'all'}"
					style="font-size:0.72rem; padding:5px 9px; border-radius:8px; cursor:pointer; {fcWindow === w ? 'color:var(--of-text); border:1px solid var(--of-accent);' : 'color:var(--of-text-3); border:1px solid var(--of-border-subtle);'} background:transparent;">{rangeLabel(w)}</button>
			{/each}
		{/if}
	</div>

	<div style="margin-top:10px;" data-testid="chart-area">
		{#if view === 'history'}
			{#if histState === 'loading'}
				<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-4);">{t.watersChartLoading}</p>
			{:else if histState === 'error'}
				<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-3);">{t.watersChartFailed}</p>
			{:else if histSeries && histSeries.points.length >= 2}
				<FlowChart points={histSeries.points} unit={unitOf(histSeries.param)} {t} />
			{:else}
				<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-4);">{t.watersNoHistory}</p>
			{/if}
		{:else if !fc || fc.status === 'loading'}
			<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-4);">{t.watersChartLoading}</p>
		{:else if fc.status === 'error'}
			<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-3);">{t.watersChartFailed}</p>
		{:else if !forecast || fcPoints.length < 2}
			<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-4);">{t.watersForecastNone}</p>
		{:else}
			<FlowChart points={fcPoints} unit={unitOf(forecast.param)} {t} dashed />
			<p style="margin:8px 0 0; font-size:0.7rem; color:var(--of-text-4); line-height:1.45;" data-testid="forecast-note">
				{forecast.source === 'nws' ? t.watersForecastNws : t.watersForecastNwm}
				{#if forecast.issuedAt} · {t.watersForecastIssued} {fmtTime(forecast.issuedAt)}{/if}
				· {t.watersForecastUntil} {fmtTime(forecast.points[forecast.points.length - 1][0])}
			</p>
		{/if}
	</div>
</article>
