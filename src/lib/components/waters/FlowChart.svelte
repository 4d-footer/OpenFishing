<script lang="ts">
	import type { Translations } from '#lib/i18n/index.js';
	import { chartGeometry, nearestIndex } from '#lib/waters/geo.js';

	let {
		points,
		unit,
		t,
		dashed = false,
		showHighLow = true
	}: {
		points: [number, number][];
		unit: 'cfs' | 'ft';
		t: Translations;
		dashed?: boolean;
		showHighLow?: boolean;
	} = $props();

	const W = 300, H = 110;
	const g = $derived(chartGeometry(points, W, H));
	let hover = $state<number | null>(null);

	const fmtVal = (v: number) => (unit === 'cfs' ? Math.round(v).toLocaleString() : v.toFixed(2));
	const fmtTime = (ms: number, withDate = true) =>
		new Date(ms).toLocaleString(undefined, withDate ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
	const fmtDay = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });

	function move(e: PointerEvent) {
		if (!g) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		hover = nearestIndex(g.xs, (e.clientX - r.left) / r.width);
	}
</script>

{#if g}
	<div>
		{#if showHighLow}
			<div style="display:flex; justify-content:space-between; gap:8px; font-size:0.7rem; color:var(--of-text-4); font-family:'JetBrains Mono',monospace; margin-bottom:4px; min-height:1.1em;">
				{#if hover !== null}
					<span style="color:var(--of-text);">{fmtVal(points[hover][1])} {unit}</span><span>{fmtTime(points[hover][0])}</span>
				{:else}
					<span>{t.watersHigh} {fmtVal(g.max)} {unit}</span><span>{t.watersLow} {fmtVal(g.min)} {unit}</span>
				{/if}
			</div>
		{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div style="position:relative; touch-action:pan-y;" onpointermove={move} onpointerleave={() => (hover = null)}>
			<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label={unit === 'cfs' ? t.watersFlow : t.watersStage}
				style="width:100%; height:{H}px; display:block;">
				<path d={g.area} fill="var(--of-accent-glow)" />
				<path d={g.line} fill="none" stroke="var(--of-accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"
					stroke-dasharray={dashed ? '5 4' : undefined} />
			</svg>
			{#if hover !== null}
				<div style="position:absolute; top:0; bottom:0; left:{g.xs[hover] * 100}%; width:1px; background:var(--of-text-4); pointer-events:none;"></div>
				<div style="position:absolute; left:{g.xs[hover] * 100}%; top:{g.ys[hover] * 100}%; width:9px; height:9px; margin:-4.5px 0 0 -4.5px; border-radius:50%; background:var(--of-accent); border:2px solid var(--of-bg-surface); pointer-events:none;"></div>
			{/if}
		</div>
		<div style="display:flex; justify-content:space-between; font-size:0.66rem; color:var(--of-text-4); margin-top:3px;">
			<span>{fmtDay(g.t0)}</span><span>{fmtDay(g.t1)}</span>
		</div>
	</div>
{/if}
