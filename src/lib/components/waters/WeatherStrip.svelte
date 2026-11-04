<script lang="ts">
	import type { Translations } from '#lib/i18n/index.js';
	import type { Weather } from '#lib/server/weather.js';
	import { compass, condition, PRESSURE_ARROW } from '#lib/waters/weather.js';

	let { w, t, loading = false }: { w: Weather | null | undefined; t: Translations; loading?: boolean } = $props();

	const cond = $derived(w ? condition(w.code, w.isDay) : null);
	const num = (v: number | null, d = 0) => (v === null ? '–' : v.toFixed(d));
</script>

<!-- Same height whether the weather is here, on its way, or missing, so tiles stay level. -->
<div data-testid="weather-strip" style="display:flex; align-items:center; gap:12px 16px; flex-wrap:wrap; min-height:44px; padding:8px 10px; border-radius:10px; background:var(--of-bg); border:1px solid var(--of-border-subtle);">
	{#if w && cond}
		<div style="display:flex; align-items:center; gap:8px;">
			<span style="font-size:1.55rem; line-height:1;" role="img" aria-label={t[cond.key]}>{cond.icon}</span>
			<div>
				<div style="font-family:'JetBrains Mono',monospace; font-size:1.05rem; font-weight:600; color:var(--of-text); line-height:1.1;" data-testid="weather-temp">{num(w.tempF)}°F</div>
				<div style="font-size:0.68rem; color:var(--of-text-3);">{t[cond.key]}{w.feelsF !== null && Math.abs(w.feelsF - (w.tempF ?? w.feelsF)) >= 3 ? ` · ${t.watersFeels} ${num(w.feelsF)}°` : ''}</div>
			</div>
		</div>
		<div style="display:flex; gap:4px 14px; flex-wrap:wrap; font-size:0.72rem; color:var(--of-text-3);">
			{#if w.windMph !== null}
				<span data-testid="weather-wind">{t.watersWind} <b style="color:var(--of-text); font-family:'JetBrains Mono',monospace; font-weight:600;">{num(w.windMph)} mph{w.windDir !== null ? ` ${compass(w.windDir)}` : ''}</b>{#if w.gustMph !== null && w.gustMph - w.windMph >= 5} · {t.watersGust} {num(w.gustMph)}{/if}</span>
			{/if}
			{#if w.humidity !== null}<span>{t.watersHumidity} <b style="color:var(--of-text); font-family:'JetBrains Mono',monospace; font-weight:600;">{num(w.humidity)}%</b></span>{/if}
			{#if w.pressureInHg !== null}
				<span data-testid="weather-pressure">{t.watersPressure} <b style="color:var(--of-text); font-family:'JetBrains Mono',monospace; font-weight:600;">{num(w.pressureInHg, 2)} inHg{w.pressureTrend ? ` ${PRESSURE_ARROW[w.pressureTrend]}` : ''}</b></span>
			{/if}
			{#if w.precipIn !== null && w.precipIn > 0}<span>{t.watersPrecip} <b style="color:var(--of-text); font-family:'JetBrains Mono',monospace; font-weight:600;">{num(w.precipIn, 2)} in</b></span>{/if}
		</div>
	{:else}
		<span style="font-size:0.74rem; color:var(--of-text-4);" data-testid="weather-missing">{loading ? t.watersChartLoading : t.watersWeatherUnavailable}</span>
	{/if}
</div>
