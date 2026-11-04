<script lang="ts">
	import 'leaflet/dist/leaflet.css';
	import { onMount, onDestroy } from 'svelte';
	import type { Translations } from '#lib/i18n/index.js';
	import type { GaugeView } from '#lib/server/waters.js';
	import { bufferBounds, framingBounds, METRICS, readingOf, formatValue, TOPO_TILE_URL, TOPO_ATTRIBUTION, TOPO_MAX_ZOOM } from '#lib/waters/geo.js';

	let {
		gauges,
		t,
		selectedId = null,
		onselect
	}: { gauges: GaugeView[]; t: Translations; selectedId?: string | null; onselect?: (id: string | null) => void } = $props();

	let mapEl: HTMLDivElement;
	let map: any = null;
	let L: any = null;
	let layer: any = null;
	let ready = $state(false);
	let framedKey = '';
	let framedSel: string | null | undefined;
	let userMoved = false;
	let observer: ResizeObserver | null = null;

	const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
	const trendArrow = (tr: string | null) => (tr === 'rising' ? '▲' : tr === 'falling' ? '▼' : tr === 'steady' ? '►' : '');
	const trendLabel = (tr: string | null) => (tr === 'rising' ? t.watersRising : tr === 'falling' ? t.watersFalling : tr === 'steady' ? t.watersSteady : '');

	function tooltip(g: GaugeView): string {
		const rows: string[] = [];
		for (const m of METRICS.slice(0, 3)) {
			const r = readingOf(g.latest, m);
			if (r) rows.push(`${esc(t[m.label])}: <b>${formatValue(r.value, m)} ${esc(m.unit)}</b>`);
		}
		if (!rows.length) rows.push(esc(t.watersNoReading));
		if (g.trend) rows.push(`${trendArrow(g.trend)} ${esc(trendLabel(g.trend))}`);
		const when = g.latest?.discharge?.time ?? g.latest?.stage?.time ?? g.latest?.extra?.['00010']?.time;
		if (when) rows.push(`<span style="opacity:.7">${esc(t.watersUpdated)} ${esc(new Date(when).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>`);
		return `<div style="font-size:12px; line-height:1.45;"><b>${esc(g.name)}</b><br>${esc(g.river ?? '')}${g.state ? ' · ' + esc(g.state) : ''}<br>${rows.join('<br>')}</div>`;
	}

	const placed = () => gauges.filter((g) => g.lat !== null && g.lng !== null);

	/** Frame the selected gauge (its 25-mile surroundings) or, with none selected, every gauge. */
	function frame(animate: boolean) {
		if (!map) return;
		map.invalidateSize();
		const sel = selectedId ? placed().find((g) => g.id === selectedId) : undefined;
		const b = sel ? bufferBounds(sel.lat!, sel.lng!) : framingBounds(placed());
		map.fitBounds(b, { padding: [12, 12], animate });
	}

	function draw() {
		if (!ready || !map || !L || !layer) return;
		layer.clearLayers();
		for (const g of placed()) {
			const on = g.id === selectedId;
			const size = on ? 24 : 18;
			const icon = L.divIcon({
				html: `<span style="display:block; width:${size}px; height:${size}px; border-radius:50%; background:var(--of-accent-solid); border:3px solid #fff; box-shadow:0 0 0 ${on ? 3 : 1}px ${on ? 'var(--of-accent-solid)' : 'rgba(0,0,0,.5)'}, 0 2px 5px rgba(0,0,0,.4);"></span>`,
				className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2]
			});
			L.marker([g.lat, g.lng], { icon, keyboard: true, title: g.name, zIndexOffset: on ? 1000 : 0 })
				.bindTooltip(tooltip(g), { direction: 'top', offset: [0, -10], opacity: 1 })
				.on('click', () => onselect?.(g.id))
				.addTo(layer);
		}
		// Re-frame when the set of gauges or the selection changes, never on a plain data refresh, so the map
		// doesn't move under someone who is panning.
		const key = placed().map((g) => g.siteId).sort().join(',');
		if (key !== framedKey || selectedId !== framedSel) {
			framedKey = key;
			framedSel = selectedId;
			userMoved = false;
			frame(selectedId !== null);
		}
	}

	onMount(async () => {
		L = (await import('leaflet')).default;
		map = L.map(mapEl, { zoomControl: true, scrollWheelZoom: false, worldCopyJump: false });
		L.tileLayer(TOPO_TILE_URL, { attribution: TOPO_ATTRIBUTION, maxNativeZoom: TOPO_MAX_ZOOM, maxZoom: TOPO_MAX_ZOOM, minZoom: 3 }).addTo(map);
		layer = L.layerGroup().addTo(map);
		map.fitBounds(framingBounds([]), { animate: false }); // a view right away, so it is never a grey box
		map.on('dragstart', () => (userMoved = true));
		mapEl.querySelector('.leaflet-control-zoom')?.addEventListener('click', () => (userMoved = true));
		// A map that was laid out at the wrong size (page still settling, tab hidden) re-frames itself once it
		// has its real size, unless the user has already moved it.
		observer = new ResizeObserver(() => {
			if (!map) return;
			map.invalidateSize();
			if (!userMoved) frame(false);
		});
		observer.observe(mapEl);
		requestAnimationFrame(() => {
			map.invalidateSize();
			ready = true;
		});
	});

	$effect(() => {
		void gauges; // redraw whenever the list, its readings or the selection change
		void selectedId;
		void ready;
		draw();
	});

	function showAll() {
		userMoved = false;
		if (selectedId !== null) onselect?.(null); // the effect re-frames to everything
		else frame(true);
	}

	onDestroy(() => {
		observer?.disconnect();
		map?.remove();
	});
</script>

<div style="position:relative; border:1px solid var(--of-border-subtle); border-radius:14px; overflow:hidden;">
	<div bind:this={mapEl} data-testid="waters-map" role="region" aria-label={t.watersMapAria} style="height:380px; background:var(--of-bg);"></div>
	{#if gauges.length > 0}
		<button type="button" onclick={showAll} data-testid="show-all"
			style="position:absolute; top:10px; right:10px; z-index:1000; font-size:0.74rem; font-weight:600; padding:6px 11px; border-radius:8px; cursor:pointer; color:#1b2733; background:#fff; border:1px solid rgba(0,0,0,.3); box-shadow:0 1px 4px rgba(0,0,0,.3);">{t.watersShowAll}</button>
	{/if}
</div>
