/**
 * Flow / stage forecasts for a USGS gauge. USGS publishes observations only; forecasts come from NOAA:
 *
 *  1. NWS river forecast (NWPS gauge): official, multi-day, but only at NWS forecast points. A USGS site is
 *     matched to an NWS gauge by its USGS id (NWPS lists `usgsId` on each gauge).
 *  2. National Water Model (NWPS reach): modeled flow for most streams. The USGS site is mapped to its reach
 *     through the USGS NLDI (comid). Usually hours to days ahead; the model can differ from the gauge.
 *
 * Everything is cached (lookups 7 days, forecasts 30 min, stale copy kept when NOAA is unreachable).
 */
import { TtlCache } from '#lib/server/usgs.js';

export const NWPS_URL = 'https://api.water.noaa.gov/nwps/v1';
export const NLDI_URL = 'https://api.water.usgs.gov/nldi/linked-data/nwissite';
const TIMEOUT_MS = 10_000;
const FORECAST_TTL = 30 * 60_000;
/** NOAA's model feed is empty between runs, so "no forecast" is remembered only briefly. */
const EMPTY_TTL = 5 * 60_000;
const LOOKUP_TTL = 7 * 24 * 3600_000;
const MIN_POINTS = 3;

export type ForecastParam = '00060' | '00065';

export interface Forecast {
	source: 'nws' | 'nwm';
	issuedAt: string | null;
	lid: string | null;
	/** Discharge (cfs) and/or gauge height (ft); each ascending [epoch ms, value]. NWM has discharge only. */
	series: Partial<Record<ForecastParam, [number, number][]>>;
}

/** Hours from `now` to the end of the longest series in a forecast. */
export function forecastHorizonHours(f: Forecast, now = Date.now()): number {
	let end = now;
	for (const pts of Object.values(f.series)) if (pts?.length) end = Math.max(end, pts[pts.length - 1][0]);
	return (end - now) / 3600_000;
}

export class ForecastError extends Error {
	/** `detail` says which call failed (for the server log). */
	constructor(public code: 'unavailable', public detail = '') {
		super(detail ? `${code}: ${detail}` : code);
	}
}

const forecastCache = new TtlCache<Forecast>(FORECAST_TTL, 500);
const emptyCache = new TtlCache<true>(EMPTY_TTL, 500);
const lidCache = new TtlCache<string | null>(LOOKUP_TTL, 2000);
const comidCache = new TtlCache<string | null>(LOOKUP_TTL, 2000);
const inflight = new Map<string, Promise<unknown>>();

export function resetForecastState(): void {
	forecastCache.clear();
	emptyCache.clear();
	lidCache.clear();
	comidCache.clear();
	inflight.clear();
}

function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const running = inflight.get(key) as Promise<T> | undefined;
	if (running) return running;
	const p = fn().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

/** GET json; null for a 404 (nothing there), throws ForecastError for trouble worth retrying later. */
async function getJson(url: string): Promise<any | null> {
	let res: Response;
	try {
		res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch (e) {
		throw new ForecastError('unavailable', `${new URL(url).host}${new URL(url).pathname} ${(e as Error)?.name ?? 'error'}`);
	}
	if (res.status === 404 || res.status === 400) return null;
	if (!res.ok) throw new ForecastError('unavailable', `${new URL(url).host}${new URL(url).pathname} HTTP ${res.status}`);
	try {
		return await res.json();
	} catch {
		throw new ForecastError('unavailable', `${new URL(url).host}${new URL(url).pathname} bad JSON`);
	}
}

const finite = (v: unknown): number | null => {
	const n = typeof v === 'string' ? Number(v) : (v as number);
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// ── NWS river forecast ──────────────────────────────────────────────────────────

/** The NWS gauge id (e.g. "GLGM8") for a USGS site, or null if NWS has no gauge for it. */
async function findLid(number: string, lat: number | null, lng: number | null): Promise<string | null> {
	const hit = lidCache.get(number);
	if (hit?.fresh) return hit.v;
	if (lat === null || lng === null) return null;
	try {
		const d = 0.03;
		const list = await getJson(
			`${NWPS_URL}/gauges?bbox.xmin=${lng - d}&bbox.ymin=${lat - d}&bbox.xmax=${lng + d}&bbox.ymax=${lat + d}&srid=EPSG_4326`
		);
		const near = ((list?.gauges ?? []) as any[])
			.filter((g) => typeof g?.lid === 'string' && /^[A-Za-z0-9]{3,8}$/.test(g.lid))
			.map((g) => ({ lid: g.lid as string, dist: Math.hypot(Number(g.latitude) - lat, Number(g.longitude) - lng) }))
			.sort((a, b) => a.dist - b.dist)
			.slice(0, 6);
		let found: string | null = null;
		for (const c of near) {
			const detail = await getJson(`${NWPS_URL}/gauges/${c.lid}`);
			if (detail && String(detail.usgsId ?? '').trim() === number) {
				found = c.lid;
				break;
			}
		}
		lidCache.set(number, found);
		return found;
	} catch (e) {
		if (hit) return hit.v;
		throw e;
	}
}

export function parseNwsForecast(body: any, lid: string): Forecast | null {
	const f = body?.forecast;
	const rows: any[] = Array.isArray(f?.data) ? f.data : [];
	if (!rows.length) return null;
	const issuedAt = typeof f.issuedTime === 'string' && !f.issuedTime.startsWith('0001') ? f.issuedTime : null;
	const keep = Date.now() - 3 * 3600_000; // the first points are often already past
	const collect = (field: 'primary' | 'secondary', scale: number): [number, number][] => {
		const out: [number, number][] = [];
		for (const r of rows) {
			const t = Date.parse(r?.validTime);
			const v = finite(r?.[field]);
			if (!Number.isFinite(t) || v === null || v <= -900 || t < keep) continue;
			out.push([t, v * scale]);
		}
		return out.sort((a, b) => a[0] - b[0]);
	};
	const secUnits = String(f.secondaryUnits).toLowerCase();
	const secScale = secUnits === 'kcfs' ? 1000 : secUnits === 'cfs' ? 1 : null;
	const series: Forecast['series'] = {};
	if (secScale !== null) {
		const flow = collect('secondary', secScale);
		if (flow.length >= MIN_POINTS) series['00060'] = flow;
	}
	if (String(f.primaryUnits).toLowerCase() === 'ft') {
		const stage = collect('primary', 1);
		if (stage.length >= MIN_POINTS) series['00065'] = stage;
	}
	return Object.keys(series).length ? { source: 'nws', issuedAt, lid, series } : null;
}

// ── National Water Model ────────────────────────────────────────────────────────

async function findComid(number: string): Promise<string | null> {
	const hit = comidCache.get(number);
	if (hit?.fresh) return hit.v;
	try {
		const body = await getJson(`${NLDI_URL}/USGS-${number}`);
		const c = body?.features?.[0]?.properties?.comid;
		const comid = c !== undefined && c !== null && /^\d{1,12}$/.test(String(c)) ? String(c) : null;
		comidCache.set(number, comid);
		return comid;
	} catch (e) {
		if (hit) return hit.v;
		throw e;
	}
}

/** Longest usable run of hourly flow in an NWPS reach response (any of its model series). */
export function parseNwmSeries(body: any): { issuedAt: string | null; points: [number, number][] } | null {
	let best: { issuedAt: string | null; points: [number, number][] } | null = null;
	const unitsScale = (u: unknown) => (/m.?3|m³/i.test(String(u)) ? 35.3147 : 1);
	const visit = (o: any, depth: number) => {
		if (!o || typeof o !== 'object' || depth > 5) return;
		if (Array.isArray(o.data) && o.data.length && typeof o.data[0] === 'object' && 'flow' in o.data[0]) {
			const k = unitsScale(o.units);
			const points: [number, number][] = [];
			for (const r of o.data) {
				const t = Date.parse(r?.validTime);
				const v = finite(r?.flow);
				if (Number.isFinite(t) && v !== null && v >= 0) points.push([t, v * k]);
			}
			points.sort((a, b) => a[0] - b[0]);
			const span = points.length ? points[points.length - 1][0] : 0;
			if (points.length >= MIN_POINTS && (!best || span > best.points[best.points.length - 1][0])) {
				best = { issuedAt: typeof o.referenceTime === 'string' ? o.referenceTime : null, points };
			}
			return;
		}
		for (const key of ['shortRange', 'mediumRange', 'mediumRangeBlend', 'longRange', 'series']) visit(o[key], depth + 1);
		if (o !== null && typeof o === 'object') for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) visit(v, depth + 1);
	};
	visit(body, 0);
	if (!best) return null;
	const keep = Date.now() - 3600_000;
	const points = (best as any).points.filter((p: [number, number]) => p[0] >= keep);
	return points.length >= MIN_POINTS ? { issuedAt: (best as any).issuedAt, points } : null;
}

async function nwmForecast(number: string): Promise<Forecast | null> {
	const comid = await findComid(number);
	if (!comid) return null;
	const urls = [
		`${NWPS_URL}/reaches/${comid}/streamflow`,
		`${NWPS_URL}/reaches/${comid}/streamflow?series=medium_range`,
		`${NWPS_URL}/reaches/${comid}/streamflow?series=medium_range_blend`
	];
	const settled = await Promise.allSettled(urls.map((u) => getJson(u)));
	if (settled.every((r) => r.status === 'rejected')) throw new ForecastError('unavailable');
	let best: ReturnType<typeof parseNwmSeries> = null;
	for (const r of settled) {
		if (r.status !== 'fulfilled') continue;
		const parsed = parseNwmSeries(r.value);
		if (parsed && (!best || parsed.points[parsed.points.length - 1][0] > best.points[best.points.length - 1][0])) best = parsed;
	}
	return best ? { source: 'nwm', issuedAt: best.issuedAt, lid: null, series: { '00060': best.points } } : null;
}

// ── Public ──────────────────────────────────────────────────────────────────────

/**
 * Best available forecast for a USGS site (NWS river forecast, else National Water Model), or null when
 * neither exists. `stale` is set when NOAA couldn't be reached and an older copy is returned.
 */
export async function getForecast(
	siteId: string,
	lat: number | null,
	lng: number | null
): Promise<{ forecast: Forecast | null; stale: boolean }> {
	const number = siteId.replace(/^USGS-/, '');
	if (!/^\d{8,15}$/.test(number)) return { forecast: null, stale: false };
	const hit = forecastCache.get(number);
	if (hit?.fresh) return { forecast: hit.v, stale: false };
	if (!hit && emptyCache.get(number)?.fresh) return { forecast: null, stale: false };
	try {
		const result = await once(`fc|${number}`, async () => {
			const lid = await findLid(number, lat, lng);
			if (lid) {
				const nws = parseNwsForecast(await getJson(`${NWPS_URL}/gauges/${lid}/stageflow`), lid);
				if (nws) return nws;
			}
			return nwmForecast(number);
		});
		if (result) forecastCache.set(number, result);
		else emptyCache.set(number, true);
		return { forecast: result, stale: false };
	} catch (e) {
		if (e instanceof ForecastError && hit) return { forecast: hit.v, stale: true };
		throw e;
	}
}
