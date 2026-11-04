<script lang="ts">
	import type { Translations } from '#lib/i18n/index.js';
	import type { GaugeView } from '#lib/server/waters.js';
	import { COND_GROUPS, COND_LABEL, type AlertRules, type CondGroup, type Range } from '#lib/waters/alerts.js';
	import { METRICS, readingOf } from '#lib/waters/geo.js';

	let { g, t, onsave, onclose }: {
		g: GaugeView; t: Translations;
		onsave: (rules: AlertRules | null) => Promise<boolean>;
		onclose: () => void;
	} = $props();

	type Key = 'flow' | 'stage' | 'waterTemp' | 'airTemp' | 'wind';
	// Only offer what this water can report: a lake has no gauge, so it gets weather only.
	const fields = $derived(
		([
			g.kind === 'gauge' && readingOf(g.latest, METRICS[0]) ? { key: 'flow', label: t.watersFlow, unit: 'cfs', both: true } : null,
			g.kind === 'gauge' && readingOf(g.latest, METRICS[1]) ? { key: 'stage', label: t.watersStage, unit: 'ft', both: true } : null,
			g.kind === 'gauge' && readingOf(g.latest, METRICS[2]) ? { key: 'waterTemp', label: t.watersTemp, unit: '°F', both: true } : null,
			{ key: 'airTemp', label: t.watersAirTemp, unit: '°F', both: true },
			{ key: 'wind', label: t.watersWind, unit: 'mph', both: false }
		] as ({ key: Key; label: string; unit: string; both: boolean } | null)[]).filter((f) => f !== null)
	);

	// svelte-ignore state_referenced_locally
	const start = g.alerts ?? {};
	const init = (r?: Range) => ({ min: r?.min ?? null, max: r?.max ?? null });
	let vals = $state<Record<Key, { min: number | null; max: number | null }>>({
		flow: init(start.flow), stage: init(start.stage), waterTemp: init(start.waterTemp), airTemp: init(start.airTemp), wind: init(start.wind)
	});
	let conds = $state<CondGroup[]>(start.conditions ? [...start.conditions] : []);
	let saving = $state(false);
	let failed = $state(false);

	// A number input binds to a number, or null when empty or not a number.
	const toNum = (v: number | null) => (v === null || v === undefined ? undefined : Number(v));
	const bad = (k: Key) => {
		const mn = toNum(vals[k].min), mx = toNum(vals[k].max);
		return (mn !== undefined && !Number.isFinite(mn)) || (mx !== undefined && !Number.isFinite(mx)) || (mn !== undefined && mx !== undefined && mn > mx);
	};
	const invalid = $derived(fields.some((f) => bad(f.key)));

	function build(): AlertRules | null {
		const out: AlertRules = {};
		for (const f of fields) {
			const mn = toNum(vals[f.key].min), mx = toNum(vals[f.key].max);
			if (mn !== undefined || mx !== undefined) out[f.key] = { ...(mn !== undefined ? { min: mn } : {}), ...(mx !== undefined ? { max: mx } : {}) };
		}
		if (conds.length) out.conditions = [...conds];
		return Object.keys(out).length ? out : null;
	}

	async function save(rules: AlertRules | null) {
		saving = true; failed = false;
		const ok = await onsave(rules);
		saving = false;
		if (ok) onclose(); else failed = true;
	}
	function clearAll() {
		for (const k of Object.keys(vals) as Key[]) vals[k] = { min: null, max: null };
		conds = [];
	}
	const toggle = (c: CondGroup) => (conds = conds.includes(c) ? conds.filter((x) => x !== c) : [...conds, c]);

	const input = (b: boolean) => `width:78px; padding:6px 8px; border-radius:8px; background:var(--of-bg); color:var(--of-text); font-size:0.82rem; font-family:'JetBrains Mono',monospace; border:1px solid ${b ? '#ef4444' : 'var(--of-border-subtle)'};`;
	const chip = (on: boolean) => `font-size:0.72rem; padding:5px 9px; border-radius:8px; cursor:pointer; background:transparent; ${on ? 'color:var(--of-text); border:1px solid var(--of-accent);' : 'color:var(--of-text-3); border:1px solid var(--of-border-subtle);'}`;
	const btn = 'font-size:0.78rem; font-weight:600; padding:7px 13px; border-radius:9px; cursor:pointer;';
</script>

<section data-testid="alert-settings" aria-label={t.watersAlertsTitle}
	style="margin-top:12px; padding:14px; border-radius:12px; background:var(--of-bg); border:1px solid var(--of-border-subtle); display:flex; flex-direction:column; gap:12px;">
	<div>
		<h3 style="margin:0; font-size:0.85rem; font-weight:700; color:var(--of-text);">{t.watersAlertsTitle}</h3>
		<p style="margin:4px 0 0; font-size:0.72rem; line-height:1.45; color:var(--of-text-4);">{t.watersAlertsIntro}</p>
	</div>
	{#each fields as f (f.key)}
		<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;" data-testid="alert-row-{f.key}">
			<span style="min-width:92px; font-size:0.76rem; color:var(--of-text-2);">{f.label} <span style="color:var(--of-text-4);">({f.unit})</span></span>
			{#if f.both}
				<input type="number" step="any" inputmode="decimal" aria-label="{f.label} {t.watersMin}" placeholder={t.watersMin} bind:value={vals[f.key].min} style={input(bad(f.key))} data-testid="alert-{f.key}-min" />
			{/if}
			<input type="number" step="any" inputmode="decimal" aria-label="{f.label} {t.watersMax}" placeholder={t.watersMax} bind:value={vals[f.key].max} style={input(bad(f.key))} data-testid="alert-{f.key}-max" />
		</div>
	{/each}
	<div>
		<div style="font-size:0.76rem; color:var(--of-text-2); margin-bottom:6px;">{t.watersConditions} <span style="color:var(--of-text-4);">· {t.watersConditionsHint}</span></div>
		<div style="display:flex; gap:6px; flex-wrap:wrap;">
			{#each COND_GROUPS as c}
				<button type="button" onclick={() => toggle(c)} aria-pressed={conds.includes(c)} data-testid="alert-cond-{c}" style={chip(conds.includes(c))}>{t[COND_LABEL[c]]}</button>
			{/each}
		</div>
	</div>
	{#if failed}<p role="alert" style="margin:0; font-size:0.76rem; color:#ef4444;">{t.watersSaveFailed}</p>{/if}
	<div style="display:flex; gap:8px; flex-wrap:wrap;">
		<button type="button" disabled={saving || invalid} onclick={() => save(build())} data-testid="alert-save"
			style="{btn} color:var(--of-accent); background:var(--of-accent-glow); border:1px solid var(--of-accent-border); opacity:{saving || invalid ? 0.5 : 1};">{t.watersSave}</button>
		<button type="button" onclick={onclose} style="{btn} color:var(--of-text-3); background:transparent; border:1px solid var(--of-border-subtle);">{t.watersCancel}</button>
		<button type="button" onclick={clearAll} data-testid="alert-clear" style="{btn} color:var(--of-text-3); background:transparent; border:1px solid var(--of-border-subtle); margin-left:auto;">{t.watersClear}</button>
	</div>
</section>
