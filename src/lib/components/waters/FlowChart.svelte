<script lang="ts">
	import type { Translations } from '#lib/i18n/index.js';
	import { dualGeometry, formatValue, nearestIndex, type Metric } from '#lib/waters/geo.js';

	let {
		history,
		forecast = [],
		metric,
		t
	}: {
		history: [number, number][];
		forecast?: [number, number][];
		metric: Metric;
		t: Translations;
	} = $props();

	const W = 300, H = 120;
	const g = $derived(dualGeometry(history, forecast, W, H));
	let hover = $state<number | null>(null);

	const fmt = (v: number) => `${formatValue(v, metric)} ${metric.unit}`;
	const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const fmtDay = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });

	function move(e: PointerEvent) {
		if (!g) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		hover = nearestIndex(g.points.map((p) => p.x), (e.clientX - r.left) / r.width);
	}
</script>

{#if g}
	{@const hp = hover !== null ? g.points[hover] : null}
	<div data-testid="flow-chart" data-hist={history.length} data-fc={forecast.length}>
		<div style="display:flex; justify-content:space-between; gap:8px; font-size:0.7rem; color:var(--of-text-4); font-family:'JetBrains Mono',monospace; margin-bottom:4px; min-height:1.1em;">
			{#if hp}
				<span style="color:var(--of-text);">{fmt(hp.v)}{hp.forecast ? ` · ${t.watersForecast}` : ''}</span><span>{fmtTime(hp.t)}</span>
			{:else}
				<span>{t.watersHigh} {fmt(g.max)}</span><span>{t.watersLow} {fmt(g.min)}</span>
			{/if}
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div style="position:relative; touch-action:pan-y;" onpointermove={move} onpointerleave={() => (hover = null)}>
			<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label={t[metric.label]} style="width:100%; height:{H}px; display:block;">
				{#if g.histArea}<path d={g.histArea} fill="var(--of-accent-glow)" />{/if}
				{#if g.histLine}<path d={g.histLine} fill="none" stroke="var(--of-accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />{/if}
				{#if g.fcArea}<path d={g.fcArea} fill="var(--of-accent-glow)" opacity="0.5" />{/if}
				{#if g.fcLine}<path d={g.fcLine} fill="none" stroke="var(--of-accent)" stroke-width="1.6" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" stroke-linejoin="round" />{/if}
			</svg>
			{#if g.nowX !== null}
				<div data-testid="chart-now" style="position:absolute; top:0; bottom:0; left:{g.nowX * 100}%; width:0; border-left:1px dashed var(--of-text-4); pointer-events:none;"></div>
			{/if}
			{#if hp}
				<div style="position:absolute; top:0; bottom:0; left:{hp.x * 100}%; width:1px; background:var(--of-text-4); pointer-events:none;"></div>
				<div style="position:absolute; left:{hp.x * 100}%; top:{hp.y * 100}%; width:9px; height:9px; margin:-4.5px 0 0 -4.5px; border-radius:50%; background:var(--of-accent); border:2px solid var(--of-bg-surface); pointer-events:none;"></div>
			{/if}
		</div>
		<div style="position:relative; height:1.1em; font-size:0.66rem; color:var(--of-text-4); margin-top:3px;">
			<span style="position:absolute; left:0;">{fmtDay(g.t0)}</span>
			{#if g.nowX !== null && g.nowX > 0.15 && g.nowX < 0.85}
				<span style="position:absolute; left:{g.nowX * 100}%; transform:translateX(-50%); color:var(--of-text-3);">{t.watersNow}</span>
			{/if}
			<span style="position:absolute; right:0;">{fmtDay(g.t1)}</span>
		</div>
	</div>
{/if}
