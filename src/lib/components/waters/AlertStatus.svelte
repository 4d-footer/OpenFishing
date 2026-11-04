<script lang="ts">
	import type { Translations } from '#lib/i18n/index.js';
	import type { GaugeView } from '#lib/server/waters.js';
	import type { Weather } from '#lib/server/weather.js';
	import { contextOf, evaluate, MARKER_COLOR, type Problem } from '#lib/waters/alerts.js';
	import { formatValue, METRICS } from '#lib/waters/geo.js';

	let { g, t, weather }: { g: GaugeView; t: Translations; weather: Weather | null | undefined } = $props();

	const ev = $derived(evaluate(g.alerts, contextOf(g.latest, weather ?? null)));
	const name = (k: Problem['key']) =>
		k === 'flow' ? t.watersFlow : k === 'stage' ? t.watersStage : k === 'waterTemp' ? t.watersTemp : k === 'airTemp' ? t.watersAirTemp : k === 'wind' ? t.watersWind : t.watersConditions;
	const detail = (p: Problem) => {
		if (p.kind === 'condition') return `${name(p.key)}: ${t.watersCondNot}`;
		const unit = p.key === 'flow' ? ' cfs' : p.key === 'stage' ? ' ft' : p.key === 'wind' ? ' mph' : '°F';
		const v = p.value === null ? '' : p.key === 'flow' ? formatValue(p.value, METRICS[0]) : p.key === 'stage' ? formatValue(p.value, METRICS[1]) : String(Math.round(p.value));
		return `${name(p.key)} ${v}${unit} ${p.kind === 'below' ? t.watersBelowMin : t.watersAboveMax}`;
	};
</script>

{#if ev.status !== 'none'}
	<div data-testid="alert-status" data-status={ev.status}
		style="margin-top:10px; display:flex; gap:8px; align-items:flex-start; font-size:0.76rem; line-height:1.4; color:var(--of-text-2);">
		<span aria-hidden="true" style="flex:none; width:10px; height:10px; margin-top:4px; border-radius:50%; background:{ev.status === 'met' ? MARKER_COLOR.good : MARKER_COLOR.bad};"></span>
		<span>
			{#if ev.status === 'met'}{t.watersMet}{:else}<b>{t.watersUnmet}:</b> {ev.problems.map(detail).join(' · ')}{/if}
		</span>
	</div>
{/if}
