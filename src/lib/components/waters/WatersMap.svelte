<script lang="ts">
	import type { Translations } from '#lib/i18n/index.js';
	import 'leaflet/dist/leaflet.css';
	import { onMount, onDestroy } from 'svelte';
	import type { GaugeView } from '#lib/server/waters.js';
	import { framingBounds, TOPO_TILE_URL, TOPO_ATTRIBUTION, TOPO_MAX_ZOOM } from '#lib/waters/geo.js';

	let { gauges, t, onselect }: { gauges: GaugeView[]; t: Translations; onselect?: (id: string) => void } = $props();

	let mapEl: HTMLDivElement;
	let map: any = null;
	let L: any = null;
	let layer: any = null;
	let ready = $state(false);
	let framedKey = '';

	const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
	const trendArrow = (tr: string | null) => (tr === 'rising' ? '▲' : tr === 'falling' ? '▼' : tr === 'steady' ? '►' : '');
	const trendLabel = (tr: string | null) => (tr === 'rising' ? t.watersRising : tr === 'falling' ? t.watersFalling : tr === 'steady' ? t.watersSteady : '');

	function tooltip(g: GaugeView): string {
		const rows: string[] = [];
		if (g.latest?.discharge) rows.push(`${esc(t.watersFlow)}: <b>${Math.round(g.latest.discharge.value).toLocaleString()} cfs</b>`);
		if (g.latest?.stage) rows.push(`${esc(t.watersStage)}: <b>${g.latest.stage.value.toFixed(2)} ft</b>`);
		if (!rows.length) rows.push(esc(t.watersNoReading));
		if (g.trend) rows.push(`${trendArrow(g.trend)} ${esc(trendLabel(g.trend))}`);
		const when = g.latest?.discharge?.time ?? g.latest?.stage?.time;
		if (when) rows.push(`<span style="opacity:.7">${esc(t.watersUpdated)} ${esc(new Date(when).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>`);
		return `<div style="font-size:12px; line-height:1.45;"><b>${esc(g.name)}</b><br>${esc(g.river ?? '')}${g.state ? ' · ' + esc(g.state) : ''}<br>${rows.join('<br>')}</div>`;
	}

	function draw() {
		if (!ready || !map || !L || !layer) return;
		layer.clearLayers();
		const placed = gauges.filter((g) => g.lat !== null && g.lng !== null);
		for (const g of placed) {
			const icon = L.divIcon({
				html: `<span style="display:block; width:18px; height:18px; border-radius:50%; background:var(--of-accent-solid); border:3px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,.5), 0 2px 5px rgba(0,0,0,.4);"></span>`,
				className: '', iconSize: [18, 18], iconAnchor: [9, 9]
			});
			L.marker([g.lat, g.lng], { icon, keyboard: true, title: g.name })
				.bindTooltip(tooltip(g), { direction: 'top', offset: [0, -10], opacity: 1 })
				.on('click', () => onselect?.(g.id))
				.addTo(layer);
		}
		// Re-frame only when the set of gauges changes, so a data refresh never moves the map under the user.
		const key = placed.map((g) => g.siteId).sort().join(',');
		if (key !== framedKey) {
			framedKey = key;
			map.fitBounds(framingBounds(placed), { padding: [12, 12], animate: false });
		}
	}

	onMount(async () => {
		L = (await import('leaflet')).default;
		map = L.map(mapEl, { zoomControl: true, scrollWheelZoom: false, worldCopyJump: false });
		L.tileLayer(TOPO_TILE_URL, { attribution: TOPO_ATTRIBUTION, maxNativeZoom: TOPO_MAX_ZOOM, maxZoom: TOPO_MAX_ZOOM, minZoom: 3 }).addTo(map);
		layer = L.layerGroup().addTo(map);
		map.fitBounds(framingBounds([]), { animate: false }); // a view right away, so it is never a grey box
		requestAnimationFrame(() => {
			map.invalidateSize();
			ready = true;
		});
	});

	$effect(() => {
		void gauges; // redraw whenever the list or its readings change
		void ready;
		draw();
	});

	onDestroy(() => map?.remove());
</script>

<div style="border:1px solid var(--of-border-subtle); border-radius:14px; overflow:hidden;">
	<div bind:this={mapEl} data-testid="waters-map" role="region" aria-label={t.watersMapAria} style="height:380px; background:var(--of-bg);"></div>
</div>
