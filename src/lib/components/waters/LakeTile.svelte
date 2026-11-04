<script lang="ts">
	import type { Translations } from '#lib/i18n/index.js';
	import type { GaugeView } from '#lib/server/waters.js';
	import type { Weather } from '#lib/server/weather.js';
	import { splitHourly, WEATHER_METRICS } from '#lib/waters/geo.js';
	import { compass, PRESSURE_ARROW } from '#lib/waters/weather.js';
	import FlowChart from './FlowChart.svelte';
	import GaugeThumb from './GaugeThumb.svelte';
	import WeatherStrip from './WeatherStrip.svelte';

	let {
		g, t, weather, weatherLoading = false, busy, selected = false, onselect, onremove
	}: {
		g: GaugeView; t: Translations; weather: Weather | null | undefined; weatherLoading?: boolean;
		busy: boolean; selected?: boolean; onselect: () => void; onremove: () => void;
	} = $props();

	let key = $state<(typeof WEATHER_METRICS)[number]['key']>('air');
	const metric = $derived(WEATHER_METRICS.find((m) => m.key === key) ?? WEATHER_METRICS[0]);
	const kindLabel = $derived(g.kind === 'reservoir' ? t.watersKindReservoir : g.kind === 'pond' ? t.watersKindPond : t.watersKindLake);
	const split = $derived(weather ? splitHourly(weather.hourly as any, metric.series) : { past: [], future: [] });

	const chip = (on: boolean) =>
		`font-size:0.72rem; padding:5px 9px; border-radius:8px; cursor:pointer; background:transparent; ${on ? 'color:var(--of-text); border:1px solid var(--of-accent);' : 'color:var(--of-text-3); border:1px solid var(--of-border-subtle);'}`;
	const rowLabel = 'font-size:0.66rem; color:var(--of-text-4); text-transform:uppercase; letter-spacing:0.06em; min-width:58px;';
</script>

<article id="tile-{g.id}" data-testid="water-tile" data-kind={g.kind} data-selected={selected}
	style="background:var(--of-bg-surface); border:1px solid {selected ? 'var(--of-accent)' : 'var(--of-border-subtle)'}; border-radius:14px; padding:18px; transition:border-color .3s;">
	<header style="display:flex; gap:12px; align-items:flex-start;">
		<button type="button" onclick={onselect} data-testid="tile-select" aria-label={g.name}
			style="display:flex; gap:12px; align-items:flex-start; flex:1; min-width:0; text-align:left; background:none; border:0; padding:0; cursor:pointer; color:inherit; font:inherit;">
			<GaugeThumb lat={g.lat} lng={g.lng} size={84} alt={t.watersThumbAlt} />
			<span style="flex:1; min-width:0; display:block;">
				<span style="display:block; font-size:0.9rem; font-weight:600; color:var(--of-text); overflow-wrap:anywhere;">{g.name}</span>
				<span style="display:block; font-size:0.72rem; color:var(--of-text-4); margin-top:2px;">{kindLabel}{g.state ? ` · ${g.state}` : ''}</span>
				<span style="display:block; font-size:0.72rem; color:var(--of-text-4); margin-top:6px;" data-testid="no-gauge">{t.watersNoGauge}</span>
			</span>
		</button>
		<button type="button" onclick={onremove} disabled={busy} aria-label={t.watersRemove} title={t.watersRemove}
			style="font-size:0.8rem; padding:3px 9px; line-height:1; border-radius:9px; cursor:pointer; color:var(--of-text-3); background:transparent; border:1px solid var(--of-border-subtle);">✕</button>
	</header>

	<div style="margin-top:14px;"><WeatherStrip w={weather} {t} loading={weatherLoading} /></div>

	{#if weather}
		<div style="display:flex; gap:22px; margin-top:14px; align-items:flex-end; flex-wrap:wrap;" data-testid="lake-readings">
			{#if weather.tempF !== null}
				<div><div style="{rowLabel}">{t.watersAirTemp}</div><div style="font-family:'JetBrains Mono',monospace; font-size:1.5rem; font-weight:600; color:var(--of-text);">{Math.round(weather.tempF)}<span style="font-size:0.75rem; color:var(--of-text-3);"> °F</span></div></div>
			{/if}
			{#if weather.pressureInHg !== null}
				<div><div style="{rowLabel}">{t.watersPressure}</div><div style="font-family:'JetBrains Mono',monospace; font-size:1.1rem; font-weight:600; color:var(--of-text);">{weather.pressureInHg.toFixed(2)}<span style="font-size:0.75rem; color:var(--of-text-3);"> inHg</span></div></div>
			{/if}
			{#if weather.windMph !== null}
				<div><div style="{rowLabel}">{t.watersWind}</div><div style="font-family:'JetBrains Mono',monospace; font-size:1.1rem; font-weight:600; color:var(--of-text);">{Math.round(weather.windMph)}<span style="font-size:0.75rem; color:var(--of-text-3);"> mph {compass(weather.windDir)}</span></div></div>
			{/if}
			{#if weather.pressureTrend}
				<div style="font-size:0.78rem; font-weight:600; color:{weather.pressureTrend === 'falling' ? 'var(--of-accent)' : 'var(--of-text-3)'};">{PRESSURE_ARROW[weather.pressureTrend]} {t.watersPressure}</div>
			{/if}
		</div>
		<div style="margin-top:4px; font-size:0.7rem; color:var(--of-text-4);">{t.watersUpdated} {new Date(weather.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
	{/if}

	<div style="margin-top:14px; display:flex; flex-direction:column; gap:7px;">
		<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;" data-testid="metric-row">
			<span style="{rowLabel}">{t.watersShowMetric}</span>
			{#each WEATHER_METRICS as m}
				<button type="button" onclick={() => (key = m.key)} aria-pressed={metric.key === m.key} data-testid="metric-{m.key}" style={chip(metric.key === m.key)}>{t[m.label]}</button>
			{/each}
		</div>
	</div>
	<div style="margin-top:10px;" data-testid="chart-area">
		{#if split.past.length + split.future.length >= 2}
			<FlowChart history={split.past} forecast={split.future} {metric} {t} />
		{:else}
			<p style="margin:12px 0; font-size:0.8rem; color:var(--of-text-4);">{weatherLoading ? t.watersChartLoading : t.watersNoHistory}</p>
		{/if}
	</div>
</article>
