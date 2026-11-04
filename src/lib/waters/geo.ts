/** Pure helpers for the My Waters map, thumbnails and charts (client-safe, no DOM). */

/** USGS "The National Map" topographic tiles (free, no key). Leaflet template: note the {y}/{x} order. */
export const TOPO_TILE_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
export const TOPO_ATTRIBUTION = 'Map: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener noreferrer">USGS The National Map</a>';
export const TOPO_MAX_ZOOM = 16;

export type LatLng = [number, number];
export type Bounds = [LatLng, LatLng]; // [[south, west], [north, east]]

/** The contiguous United States. */
export const LOWER_48: Bounds = [[24.4, -125.0], [49.6, -66.9]];

/** Miles of margin kept around every followed gauge. */
export const BUFFER_MILES = 25;
const MILES_PER_DEG_LAT = 69.0;

/** A box `miles` out from a point in every direction. */
export function bufferBounds(lat: number, lng: number, miles = BUFFER_MILES): Bounds {
	const dLat = miles / MILES_PER_DEG_LAT;
	const dLng = miles / (MILES_PER_DEG_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
	return [[lat - dLat, lng - dLng], [lat + dLat, lng + dLng]];
}

/**
 * What the map should show: the whole lower 48 with no gauges; otherwise the union of the 25-mile boxes
 * around every gauge — one gauge gives its surroundings, more gauges zoom out until all fit.
 */
export function framingBounds(points: { lat: number | null; lng: number | null }[], miles = BUFFER_MILES): Bounds {
	const valid = points.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)) as { lat: number; lng: number }[];
	if (!valid.length) return LOWER_48;
	let s = 90, w = 180, n = -90, e = -180;
	for (const p of valid) {
		const [[ps, pw], [pn, pe]] = bufferBounds(p.lat, p.lng, miles);
		s = Math.min(s, ps); w = Math.min(w, pw); n = Math.max(n, pn); e = Math.max(e, pe);
	}
	return [[s, w], [n, e]];
}

// ── Static thumbnail made of map tiles ──────────────────────────────────────────

export interface ThumbTile {
	url: string;
	left: number;
	top: number;
}

/** Tile image positions that put (lat, lng) at the centre of a `size`×`size` box at zoom `z`. */
export function thumbTiles(lat: number, lng: number, z = 12, size = 96): ThumbTile[] {
	const n = 2 ** z;
	const latRad = (lat * Math.PI) / 180;
	const gx = ((lng + 180) / 360) * n * 256;
	const gy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * 256;
	const x0 = gx - size / 2;
	const y0 = gy - size / 2;
	const tiles: ThumbTile[] = [];
	for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + size - 1) / 256); ty++) {
		for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + size - 1) / 256); tx++) {
			if (ty < 0 || ty >= n) continue;
			const wrapped = ((tx % n) + n) % n;
			tiles.push({
				url: TOPO_TILE_URL.replace('{z}', String(z)).replace('{y}', String(ty)).replace('{x}', String(wrapped)),
				left: Math.round(tx * 256 - x0),
				top: Math.round(ty * 256 - y0)
			});
		}
	}
	return tiles;
}

// ── Charts ──────────────────────────────────────────────────────────────────────

export const HOURS = 3600_000;
export const WINDOWS = [24, 48, 72, 168] as const;

/** Forecast windows a forecast can fill: the standard ones that fit, plus "all" (null) for any remainder. */
export function forecastWindows(horizonHours: number): (number | null)[] {
	const fit = WINDOWS.filter((w) => w <= horizonHours + 1);
	const out: (number | null)[] = [...fit];
	const last = fit.length ? fit[fit.length - 1] : 0;
	if (!fit.length || horizonHours > last + 6) out.push(null);
	return out;
}

/** Hours from `now` to the last forecast point. */
export function horizonHours(points: [number, number][], now = Date.now()): number {
	return points.length ? Math.max(0, (points[points.length - 1][0] - now) / HOURS) : 0;
}

/** Points inside a window: `hours` back from now (history) or ahead of now (forecast); null = everything. */
export function clip(points: [number, number][], dir: 'past' | 'future', hours: number | null, now = Date.now()): [number, number][] {
	if (dir === 'past') return hours === null ? points : points.filter((p) => p[0] >= now - hours * HOURS);
	return points.filter((p) => p[0] >= now - HOURS && (hours === null || p[0] <= now + hours * HOURS));
}

export interface ChartGeometry {
	line: string;
	area: string;
	min: number;
	max: number;
	t0: number;
	t1: number;
	xs: number[]; // x of each point, 0..1
	ys: number[]; // y of each point, 0..1 (0 = top)
}

/** Scale points into a W×H box for an SVG path, plus per-point fractions for hover marks. */
export function chartGeometry(points: [number, number][], W = 300, H = 110, pad = 6): ChartGeometry | null {
	if (points.length < 2) return null;
	const t0 = points[0][0], t1 = points[points.length - 1][0];
	let min = Infinity, max = -Infinity;
	for (const p of points) { if (p[1] < min) min = p[1]; if (p[1] > max) max = p[1]; }
	const lo = min === max ? min - 1 : min;
	const hi = min === max ? max + 1 : max;
	const fx = (t: number) => (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0));
	const fy = (v: number) => (H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2)) / H;
	const xs = points.map((p) => fx(p[0]));
	const ys = points.map((p) => fy(p[1]));
	const line = points.map((_, i) => `${i ? 'L' : 'M'}${(xs[i] * W).toFixed(1)},${(ys[i] * H).toFixed(1)}`).join('');
	return { line, area: `${line}L${(xs[xs.length - 1] * W).toFixed(1)},${H}L${(xs[0] * W).toFixed(1)},${H}Z`, min, max, t0, t1, xs, ys };
}

/** Index of the point nearest to horizontal fraction `f` (0..1) of the chart. */
export function nearestIndex(xs: number[], f: number): number {
	let best = 0, d = Infinity;
	for (let i = 0; i < xs.length; i++) { const v = Math.abs(xs[i] - f); if (v < d) { d = v; best = i; } }
	return best;
}

// ── Readings the app can show and chart ─────────────────────────────────────────

export interface Metric {
	key: 'discharge' | 'stage' | 'temp' | 'cond' | 'do' | 'ph' | 'turb' | 'air' | 'pressure' | 'wind';
	param: string; // USGS parameter code
	label: 'watersFlow' | 'watersStage' | 'watersTemp' | 'watersCond' | 'watersDO' | 'watersPH' | 'watersTurb' | 'watersAirTemp' | 'watersPressure' | 'watersWind';
	unit: string;
	decimals: number;
	/** Convert the USGS value for display (water temperature arrives in °C). */
	convert?: (v: number) => number;
	/** Whether NOAA forecasts this reading (flow and stage only). */
	forecastable: boolean;
}

export const cToF = (c: number) => (c * 9) / 5 + 32;

export const METRICS: readonly Metric[] = [
	{ key: 'discharge', param: '00060', label: 'watersFlow', unit: 'cfs', decimals: 0, forecastable: true },
	{ key: 'stage', param: '00065', label: 'watersStage', unit: 'ft', decimals: 2, forecastable: true },
	{ key: 'temp', param: '00010', label: 'watersTemp', unit: '°F', decimals: 1, convert: cToF, forecastable: false },
	{ key: 'cond', param: '00095', label: 'watersCond', unit: 'µS/cm', decimals: 0, forecastable: false },
	{ key: 'do', param: '00300', label: 'watersDO', unit: 'mg/L', decimals: 1, forecastable: false },
	{ key: 'ph', param: '00400', label: 'watersPH', unit: 'pH', decimals: 1, forecastable: false },
	{ key: 'turb', param: '63680', label: 'watersTurb', unit: 'FNU', decimals: 1, forecastable: false }
];

type LatestLike = {
	discharge: { value: number; time: string } | null;
	stage: { value: number; time: string } | null;
	extra?: Partial<Record<string, { value: number; time: string }>>;
} | null | undefined;

/** The latest reading for a metric, in display units, or null if the gauge doesn't report it. */
export function readingOf(latest: LatestLike, m: Metric): { value: number; time: string } | null {
	const r = m.key === 'discharge' ? latest?.discharge : m.key === 'stage' ? latest?.stage : latest?.extra?.[m.param];
	return r ? { value: m.convert ? m.convert(r.value) : r.value, time: r.time } : null;
}

/** Metrics a gauge reports right now, in display order. */
export function availableMetrics(latest: LatestLike): Metric[] {
	return METRICS.filter((m) => readingOf(latest, m) !== null);
}

export const formatValue = (v: number, m: Pick<Metric, 'decimals'>) =>
	m.decimals === 0 ? Math.round(v).toLocaleString() : v.toFixed(m.decimals);

// ── History + forecast on one chart ─────────────────────────────────────────────

export interface DualPoint {
	x: number; // 0..1 across the chart
	y: number; // 0..1 down the chart (0 = top)
	t: number;
	v: number;
	forecast: boolean;
}

export interface DualGeometry {
	histLine: string;
	histArea: string;
	fcLine: string;
	fcArea: string;
	nowX: number | null; // where "now" falls, when both halves are drawn
	min: number;
	max: number;
	t0: number;
	t1: number;
	/** Y-axis labels: value and where it sits (0 = top, 1 = bottom). */
	ticks: { v: number; y: number }[];
	/** Digits after the point that tick labels need. */
	tickDecimals: number;
	points: DualPoint[];
}

/**
 * A tidy axis around [min, max]: round-numbered steps (1, 2, 2.5, 5 × 10ⁿ), a domain that snaps outward to
 * them, and the number of decimals the labels need. A flat series gets a padded domain so it reads as flat.
 */
export function niceScale(min: number, max: number, target = 4): { lo: number; hi: number; ticks: number[]; decimals: number } {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1], decimals: 0 };
	if (max < min) [min, max] = [max, min];
	let span = max - min;
	if (span < Math.max(Math.abs(max), Math.abs(min), 1e-9) * 1e-6) {
		const pad = Math.max(Math.abs(max) * 0.05, 0.5);
		min -= pad; max += pad; span = max - min;
	}
	const raw = span / Math.max(target, 1);
	const pow = 10 ** Math.floor(Math.log10(raw));
	const f = raw / pow;
	const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
	const lo = Math.floor(min / step + 1e-9) * step;
	const hi = Math.ceil(max / step - 1e-9) * step;
	let decimals = 0;
	while (decimals < 6 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-6) decimals++;
	const ticks: number[] = [];
	for (let v = lo, i = 0; v <= hi + step * 1e-6 && i < 50; v += step, i++) ticks.push(Number(v.toFixed(8)));
	return { lo, hi, ticks, decimals };
}

/**
 * Lay a history series and a forecast series on one time axis (solid, then dashed from the last observed
 * point). Forecast points that fall inside the history are dropped so the two never overlap.
 */
export function dualGeometry(history: [number, number][], forecast: [number, number][], W = 300, H = 110, pad = 6): DualGeometry | null {
	const lastHist = history.length ? history[history.length - 1][0] : -Infinity;
	const fc = forecast.filter((p) => p[0] > lastHist);
	if (history.length + fc.length < 2) return null;
	const all = [...history, ...fc];
	const t0 = all[0][0], t1 = all[all.length - 1][0];
	let min = Infinity, max = -Infinity;
	for (const p of all) { if (p[1] < min) min = p[1]; if (p[1] > max) max = p[1]; }
	const sc = niceScale(min, max, 3);
	const lo = sc.lo, hi = sc.hi;
	const fx = (t: number) => (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0));
	const fy = (v: number) => (H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2)) / H;
	const path = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${(fx(p[0]) * W).toFixed(1)},${(fy(p[1]) * H).toFixed(1)}`).join('');
	const area = (pts: [number, number][]) => (pts.length < 2 ? '' : `${path(pts)}L${(fx(pts[pts.length - 1][0]) * W).toFixed(1)},${H}L${(fx(pts[0][0]) * W).toFixed(1)},${H}Z`);
	const seam: [number, number][] = history.length && fc.length ? [history[history.length - 1], ...fc] : fc;
	return {
		histLine: history.length >= 2 ? path(history) : '',
		histArea: area(history),
		fcLine: seam.length >= 2 ? path(seam) : '',
		fcArea: area(seam),
		nowX: history.length && fc.length ? fx(lastHist) : null,
		min, max, t0, t1,
		ticks: sc.ticks.map((v) => ({ v, y: fy(v) })),
		tickDecimals: sc.decimals,
		points: [
			...history.map((p) => ({ x: fx(p[0]), y: fy(p[1]), t: p[0], v: p[1], forecast: false })),
			...fc.map((p) => ({ x: fx(p[0]), y: fy(p[1]), t: p[0], v: p[1], forecast: true }))
		]
	};
}

// ── Weather charts (lakes have no gauge, so the weather is what they chart) ─────

export const WEATHER_METRICS: (Metric & { series: 'tempF' | 'pressureInHg' | 'windMph' })[] = [
	{ key: 'air', param: 'air', label: 'watersAirTemp', unit: '°F', decimals: 0, forecastable: true, series: 'tempF' },
	{ key: 'pressure', param: 'pressure', label: 'watersPressure', unit: 'inHg', decimals: 2, forecastable: true, series: 'pressureInHg' },
	{ key: 'wind', param: 'wind', label: 'watersWind', unit: 'mph', decimals: 0, forecastable: true, series: 'windMph' }
];

/** Split an hourly weather series into what has happened and what is expected, around `now`. */
export function splitHourly(hourly: { t: number[] } & Record<string, number[]>, field: string, now = Date.now()): { past: [number, number][]; future: [number, number][] } {
	const past: [number, number][] = [], future: [number, number][] = [];
	const vals = hourly[field] ?? [];
	for (let i = 0; i < hourly.t.length; i++) {
		const v = vals[i];
		if (typeof v !== 'number' || !Number.isFinite(v)) continue;
		(hourly.t[i] <= now ? past : future).push([hourly.t[i], v]);
	}
	return { past, future };
}
