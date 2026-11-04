<script lang="ts">
	import { onMount } from 'svelte';
	import type { Translations } from '#lib/i18n/index.js';
	import type { GaugeView } from '#lib/server/waters.js';
	import type { Forecast } from '#lib/server/forecast.js';
	import { availableMetrics, clip, forecastWindows, formatValue, METRICS, readingOf, WINDOWS, type Metric } from '#lib/waters/geo.js';
	import { queued } from '#lib/stores/waters.svelte.js';
	import FlowChart from './FlowChart.svelte';
	import GaugeThumb from './GaugeThumb.svelte';
	import WeatherStrip from './WeatherStrip.svelte';
	import type { Weather } from '#lib/server/weather.js';

	let {
		g,
		t,
		pending,
		weather,
		weatherLoading = false,
		busy,
		selected = false,
		onselect,
		onremove
	}: {
		g: GaugeView;
		t: Translations;
		pending: boolean; // first readings still on their way
		weather: Weather | null | undefined;
		weatherLoading?: boolean;
		busy: boolean;
		selected?: boolean;
		onselect: () => void;
		onremove: () => void;
	} = $props();

	type Series = { param: string; points: [number, number][] } | null;
	type Load<T> = { status: 'loading' | 'ok' | 'error'; value?: T };

	const metrics = $derived(availableMetrics(g.latest));
	let metricKey = $state<Metric['key'] | null>(null);
	let hours = $state<number>(24);
	let fcSel = $state<number | null | 'off' | undefined>(undefined); // undefined: choose when the forecast arrives
	let hist = $state<Record<string, Load<Series>>>({});
	let fc = $state<Load<Forecast | null>>({ status: 'loading' });
	let alt = $state<Forecast | null>(null);
	let srcSel = $state<'primary' | 'alternate'>('primary');

	// The metric on show: the one picked, else flow, else stage, else whatever the gauge has.
	const metric = $derived<Metric | null>(metrics.find((m) => m.key === metricKey) ?? metrics[0] ?? null);

	const rangeLabel = (h: number | null) =>
		h === 24 ? t.watersRange24 : h === 48 ? t.watersRange48 : h === 72 ? t.watersRange72 : h === 168 ? t.watersRange168 : t.watersForecastAll;
	const fmtTime = (ms: number | string) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const trendLabel = (tr: string | null) => (tr === 'rising' ? t.watersRising : tr === 'falling' ? t.watersFalling : tr === 'steady' ? t.watersSteady : '');
	const trendArrow = (tr: string | null) => (tr === 'rising' ? '▲' : tr === 'falling' ? '▼' : tr === 'steady' ? '►' : '');

	const flow = $derived(readingOf(g.latest, METRICS[0]));
	const stage = $derived(readingOf(g.latest, METRICS[1]));
	const temp = $derived(readingOf(g.latest, METRICS[2]));
	const others = $derived(METRICS.slice(3).map((m) => ({ m, r: readingOf(g.latest, m) })).filter((x) => x.r));
	const latestTime = $derived(flow?.time ?? stage?.time ?? temp?.time ?? null);

	// ── History (the preloaded 24 h of flow/stage; everything else on demand) ──
	const histKey = $derived(metric ? `${metric.param}|${hours}` : '');
	async function loadHistory() {
		if (!metric) return;
		const key = histKey;
		if (g.series?.param === metric.param && hours === 24) return; // already preloaded
		if (hist[key]?.status === 'ok' || hist[key]?.status === 'loading') return;
		hist[key] = { status: 'loading' };
		try {
			const res = await fetch(`/api/waters/${g.id}/history?hours=${hours}&param=${metric.param}`);
			if (!res.ok) throw new Error(String(res.status));
			hist[key] = { status: 'ok', value: (await res.json()).series };
		} catch {
			hist[key] = { status: 'error' };
		}
	}
	$effect(() => {
		void histKey;
		loadHistory();
	});

	const histRaw = $derived<Series>(
		!metric ? null : g.series?.param === metric.param && hours === 24 ? g.series : (hist[histKey]?.value ?? null)
	);
	const histState = $derived<'loading' | 'error' | 'ok'>(
		!metric ? 'ok' : g.series?.param === metric.param && hours === 24 ? 'ok' : (hist[histKey]?.status ?? 'loading')
	);
	const histPoints = $derived<[number, number][]>(
		histRaw && metric ? clip(histRaw.points, 'past', hours).map((p) => [p[0], metric.convert ? metric.convert(p[1]) : p[1]] as [number, number]) : []
	);

	// ── Forecast (flow and stage only), loaded once per tile, two at a time ──
	async function loadForecast() {
		fc = { status: 'loading' };
		try {
			const res = await queued(() => fetch(`/api/waters/${g.id}/forecast`));
			if (!res.ok) throw new Error(String(res.status));
			const body = await res.json();
			alt = (body.alternate as Forecast | null) ?? null;
			fc = { status: 'ok', value: (body.forecast as Forecast | null) ?? null };
		} catch {
			fc = { status: 'error' };
		}
	}
	onMount(() => {
		loadForecast();
	});

	const primary = $derived(fc.status === 'ok' ? (fc.value ?? null) : null);
	const forecast = $derived(srcSel === 'alternate' && alt && metric?.param === '00060' ? alt : primary);
	const flatNws = $derived(!!alt && primary?.source === 'nws');
	const fcPointsAll = $derived<[number, number][]>(metric?.forecastable && forecast ? (forecast.series[metric.param as '00060' | '00065'] ?? []) : []);
	const fcHorizon = $derived(fcPointsAll.length ? (fcPointsAll[fcPointsAll.length - 1][0] - Date.now()) / 3600_000 : 0);
	const windows = $derived(fcPointsAll.length >= 2 ? forecastWindows(fcHorizon) : []);
	// Until the user picks, show the shortest window that exists (24 h, or all of a shorter forecast).
	const fcChoice = $derived<number | null | 'off'>(fcSel !== undefined ? fcSel : (windows[0] ?? 'off'));
	const fcPoints = $derived<[number, number][]>(
		fcChoice === 'off' || !fcPointsAll.length ? [] : clip(fcPointsAll, 'future', fcChoice)
	);

	const fcStatus = $derived.by(() => {
		if (!metric?.forecastable) return 'n/a';
		if (fc.status === 'loading') return 'loading';
		if (fc.status === 'error') return 'error';
		return windows.length ? 'ok' : 'none';
	});

	const chip = (on: boolean) =>
		`font-size:0.72rem; padding:5px 9px; border-radius:8px; cursor:pointer; background:transparent; ${on ? 'color:var(--of-text); border:1px solid var(--of-accent);' : 'color:var(--of-text-3); border:1px solid var(--of-border-subtle);'}`;
	const rowLabel = 'font-size:0.66rem; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em; min-width:58px;';
</script>

<article id="tile-{g.id}" data-testid="water-tile" data-selected={selected}
	style="background:var(--of-bg-surface); border:1px solid {selected ? 'var(--of-accent)' : 'var(--of-border-subtle)'}; border-radius:14px; padding:18px; transition:border-color .3s;">
	<header style="display:flex; gap:12px; align-items:flex-start;">
		<button type="button" onclick={onselect} data-testid="tile-select" aria-label={g.name}
			style="display:flex; gap:12px; align-items:flex-start; flex:1; min-width:0; text-align:left; background:none; border:0; padding:0; cursor:pointer; color:inherit; font:inherit;">
			<GaugeThumb lat={g.lat} lng={g.lng} size={84} alt={t.watersThumbAlt} />
			<span style="flex:1; min-width:0; display:block;">
				<span style="display:block; font-size:0.9rem; font-weight:600; color:var(--of-text); overflow-wrap:anywhere;">{g.name}</span>
				<span style="display:block; font-size:0.72rem; color:var(--of-text-4); margin-top:2px;">{g.river ?? ''}{g.state ? ` · ${g.state}` : ''}</span>
			</span>
		</button>
		<button type="button" onclick={onremove} disabled={busy} aria-label={t.watersRemove} title={t.watersRemove}
			style="font-size:0.8rem; padding:3px 9px; line-height:1; border-radius:9px; cursor:pointer; color:var(--of-text-3); background:transparent; border:1px solid var(--of-border-subtle);">✕</button>
	</header>
	{#if g.usgsUrl}<a href={g.usgsUrl} target="_blank" rel="noopener noreferrer" style="display:inline-block; margin:6px 0 0 96px; font-size:0.72rem; color:var(--of-text-3);">{t.watersViewUsgs} ↗</a>{/if}

	<div style="margin-top:12px;"><WeatherStrip w={weather} {t} loading={weatherLoading} /></div>

	{#if pending && !g.latest}
		<p style="margin:16px 0 4px; font-size:0.8rem; color:var(--of-text-4);">{t.watersRefreshing}</p>
	{:else if !metric}
		<p style="margin:16px 0 4px; font-size:0.8rem; color:var(--of-text-4);">{t.watersNoReading}</p>
	{:else}
		<div style="display:flex; gap:22px; margin-top:14px; align-items:flex-end; flex-wrap:wrap;">
			{#if flow}
				<div>
					<div style="{rowLabel}">{t.watersFlow}</div>
					<div style="font-family:'JetBrains Mono',monospace; font-size:1.5rem; font-weight:600; color:var(--of-text);">{formatValue(flow.value, METRICS[0])}<span style="font-size:0.75rem; color:var(--of-text-3);"> cfs</span></div>
				</div>
			{/if}
			{#if stage}
				<div>
					<div style="{rowLabel}">{t.watersStage}</div>
					<div style="font-family:'JetBrains Mono',monospace; font-size:{flow ? '1.1rem' : '1.5rem'}; font-weight:600; color:var(--of-text);">{formatValue(stage.value, METRICS[1])}<span style="font-size:0.75rem; color:var(--of-text-3);"> ft</span></div>
				</div>
			{/if}
			{#if temp}
				<div data-testid="reading-temp">
					<div style="{rowLabel}">{t.watersTemp}</div>
					<div style="font-family:'JetBrains Mono',monospace; font-size:{flow || stage ? '1.1rem' : '1.5rem'}; font-weight:600; color:var(--of-text);">{formatValue(temp.value, METRICS[2])}<span style="font-size:0.75rem; color:var(--of-text-3);"> °F</span></div>
				</div>
			{/if}
			{#if g.trend}
				<div style="font-size:0.78rem; font-weight:600; color:{g.trend === 'rising' ? 'var(--of-accent)' : 'var(--of-text-3)'};">{trendArrow(g.trend)} {trendLabel(g.trend)}</div>
			{/if}
		</div>
		{#if others.length}
			<div style="display:flex; gap:16px; flex-wrap:wrap; margin-top:8px; font-size:0.74rem; color:var(--of-text-3);" data-testid="reading-others">
				{#each others as { m, r }}
					<span>{t[m.label]} <b style="color:var(--of-text); font-family:'JetBrains Mono',monospace; font-weight:600;">{formatValue(r!.value, m)}</b>{m.unit === 'pH' ? '' : ` ${m.unit}`}</span>
				{/each}
			</div>
		{/if}
		{#if latestTime}<div style="margin-top:4px; font-size:0.7rem; color:var(--of-text-4);">{t.watersUpdated} {fmtTime(latestTime)}</div>{/if}

		<!-- What to chart: reading, how far back, how far ahead -->
		<div style="margin-top:14px; display:flex; flex-direction:column; gap:7px;">
			{#if metrics.length > 1}
				<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;" data-testid="metric-row">
					<span style="{rowLabel}">{t.watersShowMetric}</span>
					{#each metrics as m}
						<button type="button" onclick={() => (metricKey = m.key)} aria-pressed={metric.key === m.key} data-testid="metric-{m.key}" style={chip(metric.key === m.key)}>{t[m.label]}</button>
					{/each}
				</div>
			{/if}
			<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
				<span style="{rowLabel}">{t.watersHistory}</span>
				{#each WINDOWS as h}
					<button type="button" onclick={() => (hours = h)} aria-pressed={hours === h} data-testid="range-{h}" style={chip(hours === h)}>{rangeLabel(h)}</button>
				{/each}
			</div>
			{#if metric.forecastable && alt && primary && (metric.param === '00060')}
				<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;" data-testid="source-row">
					<span style="{rowLabel}">{t.watersForecastSource}</span>
					<button type="button" onclick={() => (srcSel = 'primary')} aria-pressed={srcSel === 'primary'} data-testid="src-primary" style={chip(srcSel === 'primary')}>{primary.source === 'nws' ? t.watersSrcNws : t.watersSrcModel}</button>
					<button type="button" onclick={() => (srcSel = 'alternate')} aria-pressed={srcSel === 'alternate'} data-testid="src-alternate" style={chip(srcSel === 'alternate')}>{t.watersSrcModel}</button>
				</div>
			{/if}
			{#if metric.forecastable}
				<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;" data-testid="forecast-row">
					<span style="{rowLabel}">{t.watersForecast}</span>
					{#if fcStatus === 'ok'}
						<button type="button" onclick={() => (fcSel = 'off')} aria-pressed={fcChoice === 'off'} data-testid="fc-range-off" style={chip(fcChoice === 'off')}>{t.watersOff}</button>
						{#each windows as w}
							<button type="button" onclick={() => (fcSel = w)} aria-pressed={fcChoice === w} data-testid="fc-range-{w ?? 'all'}" style={chip(fcChoice === w)}>{rangeLabel(w)}</button>
						{/each}
					{:else if fcStatus === 'loading'}
						<span style="font-size:0.74rem; color:var(--of-text-4);">{t.watersChartLoading}</span>
					{:else if fcStatus === 'error'}
						<span style="font-size:0.74rem; color:var(--of-text-3);" data-testid="fc-error">{t.watersForecastFailed}</span>
					{:else}
						<span style="font-size:0.74rem; color:var(--of-text-4);" data-testid="fc-none">{t.watersForecastNone}</span>
					{/if}
				</div>
			{/if}
		</div>

		<div style="margin-top:10px;" data-testid="chart-area">
			{#if histState === 'loading' && !fcPoints.length}
				<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-4);">{t.watersChartLoading}</p>
			{:else if histState === 'error' && !fcPoints.length}
				<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-3);">{t.watersChartFailed}</p>
			{:else if histPoints.length + fcPoints.length >= 2}
				<FlowChart history={histPoints} forecast={fcPoints} {metric} {t} />
				{#if flatNws && forecast === primary && metric?.param === '00060' && fcPoints.length}
					<p style="margin:8px 0 0; font-size:0.7rem; color:var(--of-text-3); line-height:1.45;" data-testid="flat-note">{t.watersForecastFlat}</p>
				{/if}
				{#if fcPoints.length && forecast}
					<p style="margin:8px 0 0; font-size:0.7rem; color:var(--of-text-4); line-height:1.45;" data-testid="forecast-note">
						{forecast.source === 'nws' ? t.watersForecastNws : t.watersForecastNwm}
						{#if forecast.issuedAt} · {t.watersForecastIssued} {fmtTime(forecast.issuedAt)}{/if}
						· {t.watersForecastUntil} {fmtTime(fcPointsAll[fcPointsAll.length - 1][0])}
					</p>
				{/if}
			{:else}
				<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-4);">{t.watersNoHistory}</p>
			{/if}
		</div>
	{/if}
</article>
