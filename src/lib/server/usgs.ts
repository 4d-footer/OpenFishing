import { env } from '#lib/server/env.js';

/**
 * Client for the USGS Water Data OGC API (https://api.waterdata.usgs.gov). The legacy NWIS
 * services (waterservices.usgs.gov) are being retired, so this uses only the new API.
 *
 * Every call goes through `usgsGet`, which adds an optional API key, a timeout, and a global
 * back-off after HTTP 429. Results are cached in memory (shared by all users), so a handful of
 * people opening the app costs one USGS request per cache window, not one each — the
 * unauthenticated limit is only ~50-100 requests per hour per IP.
 */

const DEFAULT_BASE = 'https://api.waterdata.usgs.gov/ogcapi/v1';
export const DISCHARGE = '00060'; // cubic feet per second
export const STAGE = '00065'; // gauge height, feet

export const SEARCH_LIMIT = 500;
const CHUNK = 100; // ids per request (URL stays ~2 KB)
const TIMEOUT_MS = 8000;
const BACKOFF_MS = 60_000;
const ACTIVE_WITHIN_MS = 7 * 24 * 3600 * 1000; // a gauge counts as active if it reported this recently

const TTL = {
	latest: 5 * 60_000,
	series: 10 * 60_000,
	site: 24 * 3600_000,
	search: 60 * 60_000
};
const STALE_KEEP_MS = 24 * 3600_000; // how long an expired entry may still be served when USGS is down

export type UsgsErrorCode = 'rate_limited' | 'unavailable';
export class UsgsError extends Error {
	constructor(public code: UsgsErrorCode, message?: string) {
		super(message ?? code);
	}
}

export interface Gauge {
	siteId: string; // "USGS-06934500"
	number: string; // "06934500"
	name: string;
	river: string; // display label, e.g. "Missouri River"
	state: string | null;
	lat: number | null;
	lng: number | null;
}

export interface Reading {
	value: number;
	time: string; // ISO
}
export interface Latest {
	discharge: Reading | null;
	stage: Reading | null;
}
export interface Series {
	param: typeof DISCHARGE | typeof STAGE;
	points: [number, number][]; // [epoch ms, value], ascending
}
export type Trend = 'rising' | 'falling' | 'steady';

// ── Small TTL cache ────────────────────────────────────────────────────────────

class TtlCache<V> {
	private m = new Map<string, { v: V; exp: number }>();
	constructor(private ttl: number, private max = 2000) {}
	get(key: string): { v: V; fresh: boolean } | undefined {
		const e = this.m.get(key);
		if (!e) return undefined;
		const now = Date.now();
		if (now > e.exp + STALE_KEEP_MS) {
			this.m.delete(key);
			return undefined;
		}
		return { v: e.v, fresh: now <= e.exp };
	}
	set(key: string, v: V) {
		if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
		this.m.set(key, { v, exp: Date.now() + this.ttl });
	}
	clear() {
		this.m.clear();
	}
}

const latestCache = new TtlCache<Latest>(TTL.latest);
const seriesCache = new TtlCache<Series | null>(TTL.series);
const siteCache = new TtlCache<Gauge | null>(TTL.site);
const searchCache = new TtlCache<{ gauges: Gauge[]; truncated: boolean }>(TTL.search, 200);
const inflight = new Map<string, Promise<unknown>>();
let backoffUntil = 0;

/** Test helper: forget everything. */
export function resetUsgsState(): void {
	latestCache.clear();
	seriesCache.clear();
	siteCache.clear();
	searchCache.clear();
	inflight.clear();
	backoffUntil = 0;
}

function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const running = inflight.get(key) as Promise<T> | undefined;
	if (running) return running;
	const p = fn().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

function baseUrl(): string {
	return (env.USGS_API_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, '');
}

async function usgsGet(path: string, params: Record<string, string | number>): Promise<any> {
	if (Date.now() < backoffUntil) throw new UsgsError('rate_limited');
	const url = new URL(`${baseUrl()}/${path}`);
	url.searchParams.set('f', 'json');
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

	const headers: Record<string, string> = { accept: 'application/json' };
	const key = env.USGS_API_KEY?.trim();
	if (key) headers['X-Api-Key'] = key;

	let res: Response;
	try {
		res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch {
		throw new UsgsError('unavailable');
	}
	if (res.status === 429) {
		const retry = Number(res.headers.get('retry-after'));
		backoffUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 15 * 60_000) : BACKOFF_MS);
		throw new UsgsError('rate_limited');
	}
	if (!res.ok) throw new UsgsError('unavailable', `USGS HTTP ${res.status}`);
	try {
		return await res.json();
	} catch {
		throw new UsgsError('unavailable', 'USGS returned invalid JSON');
	}
}

// ── River names ────────────────────────────────────────────────────────────────

const KINDS: Record<string, { full: string; aliases: string[] }> = {
	RIVER: { full: 'RIVER', aliases: ['R', 'RIVER'] },
	CREEK: { full: 'CREEK', aliases: ['CR', 'CK', 'CREEK'] },
	FORK: { full: 'FORK', aliases: ['FK', 'FORK'] },
	BROOK: { full: 'BROOK', aliases: ['BRK', 'BROOK'] },
	BRANCH: { full: 'BRANCH', aliases: ['BR', 'BRANCH'] },
	BAYOU: { full: 'BAYOU', aliases: ['BAYOU'] },
	RUN: { full: 'RUN', aliases: ['RUN'] },
	CANAL: { full: 'CANAL', aliases: ['CANAL'] }
};
const ALIAS_TO_KIND = new Map<string, string>();
for (const [k, v] of Object.entries(KINDS)) for (const a of v.aliases) ALIAS_TO_KIND.set(a, k);

export interface ParsedQuery {
	base: string; // upper-case, e.g. "MISSOURI" or "LITTLE MISSOURI"
	kind: keyof typeof KINDS;
}

/** "Missouri River" / "missouri r" / "Missouri" → { base: 'MISSOURI', kind: 'RIVER' }; null if unusable. */
export function parseQuery(raw: string): ParsedQuery | null {
	const up = (raw ?? '')
		.toUpperCase()
		.replace(/[^A-Z0-9 .'\-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!up) return null;
	const tokens = up.split(' ');
	let kind = 'RIVER';
	const last = tokens[tokens.length - 1].replace(/\.$/, '');
	if (tokens.length > 1 && ALIAS_TO_KIND.has(last)) {
		kind = ALIAS_TO_KIND.get(last)!;
		tokens.pop();
	}
	const base = tokens.join(' ').trim();
	if (base.replace(/[^A-Z0-9]/g, '').length < 3 || base.length > 40) return null;
	if (ALIAS_TO_KIND.has(base)) return null; // "river", "creek": a type word on its own is not a name
	return { base, kind };
}

const esc = (s: string) => s.replace(/'/g, "''");

/** Variants of a base name as USGS might spell it ("ST. CROIX" / "ST CROIX"). */
function baseVariants(base: string): string[] {
	const out = new Set<string>([base, base.replace(/\./g, '')]);
	if (/^ST /.test(base)) out.add(base.replace(/^ST /, 'ST. '));
	return [...out];
}

/** CQL2 text filter selecting stream sites whose name looks like "<base> <kind> …", any case. */
export function buildNameFilter(q: ParsedQuery): string {
	const parts: string[] = [];
	for (const b of baseVariants(q.base)) {
		for (const alias of KINDS[q.kind].aliases) {
			for (const tail of [' ', ',']) {
				parts.push(`CASEI(monitoring_location_name) LIKE CASEI('%${esc(b.toLowerCase())} ${alias.toLowerCase()}${tail}%')`);
			}
		}
	}
	return `site_type_code = 'ST' AND (${parts.join(' OR ')})`;
}

const CUT_RE = /\s+(?:NO\.?\s*\d+[A-Z]?|#\s*\d+|AT|NEAR|NR|AB|ABV|ABOVE|BL|BLW|BELOW|BEL|ABO|DS|US|D\/S|U\/S)\b|,|\(/i;
const TOKEN_EXPAND: Record<string, string> = { R: 'RIVER', CR: 'CREEK', CK: 'CREEK', FK: 'FORK', BR: 'BRANCH', BRK: 'BROOK' };

/** The river part of a gauge name, expanded and upper-cased: "MISSOURI R NO. 7 NR TRENTON, ND" → "MISSOURI RIVER". */
export function riverKey(name: string): string {
	const cut = name.search(CUT_RE);
	const head = (cut > 0 ? name.slice(0, cut) : name).trim().toUpperCase();
	return head
		.split(/\s+/)
		.map((t) => TOKEN_EXPAND[t.replace(/\.$/, '')] ?? t)
		.join(' ');
}

const SMALL = new Set(['of', 'the', 'and', 'de', 'la']);
export function titleCase(s: string): string {
	return s
		.toLowerCase()
		.split(' ')
		.map((w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/(^|[-'.(])([a-z])/g, (_m, a, b) => a + b.toUpperCase())))
		.join(' ');
}
export function riverLabel(name: string): string {
	return titleCase(riverKey(name));
}

/** 'exact' = the river itself; 'related' = another river whose name ends the same ("Little Missouri River"). */
function matchKind(name: string, q: ParsedQuery): 'exact' | 'related' | null {
	const key = riverKey(name).replace(/\./g, '');
	const full = KINDS[q.kind].full;
	let out: 'exact' | 'related' | null = null;
	for (const b of baseVariants(q.base)) {
		const bb = b.replace(/\./g, '');
		if (key === `${bb} ${full}`) return 'exact';
		if (key.endsWith(` ${bb} ${full}`)) out = 'related';
	}
	return out;
}

// ── Parsing ────────────────────────────────────────────────────────────────────

function toGauge(f: any): Gauge | null {
	const p = f?.properties;
	const siteId = p?.id ?? f?.id;
	const name = p?.monitoring_location_name;
	if (typeof siteId !== 'string' || !/^USGS-\d{8,15}$/.test(siteId) || typeof name !== 'string') return null;
	const c = f?.geometry?.coordinates;
	return {
		siteId,
		number: siteId.slice(5),
		name: name.trim(),
		river: riverLabel(name),
		state: typeof p.state_name === 'string' ? p.state_name : null,
		lng: Array.isArray(c) && typeof c[0] === 'number' ? c[0] : null,
		lat: Array.isArray(c) && typeof c[1] === 'number' ? c[1] : null
	};
}

const num = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
};

// ── Latest readings ────────────────────────────────────────────────────────────

const EMPTY_LATEST: Latest = { discharge: null, stage: null };

function parseLatest(features: any[]): Map<string, Latest> {
	const out = new Map<string, Latest>();
	for (const f of features) {
		const p = f?.properties;
		const id = p?.monitoring_location_id;
		const value = num(p?.value);
		if (typeof id !== 'string' || value === null || typeof p?.time !== 'string') continue;
		const cur = out.get(id) ?? { discharge: null, stage: null };
		const key = p.parameter_code === DISCHARGE ? 'discharge' : p.parameter_code === STAGE ? 'stage' : null;
		if (!key) continue;
		const existing = cur[key];
		if (!existing || Date.parse(p.time) > Date.parse(existing.time)) cur[key] = { value, time: p.time };
		out.set(id, cur);
	}
	return out;
}

/** Latest discharge and stage for the given sites. Serves stale data (flagged) if USGS fails. */
export async function getLatest(ids: string[]): Promise<{ data: Map<string, Latest>; stale: boolean }> {
	const unique = [...new Set(ids)];
	const data = new Map<string, Latest>();
	const missing: string[] = [];
	for (const id of unique) {
		const hit = latestCache.get(id);
		if (hit) data.set(id, hit.v);
		if (!hit?.fresh) missing.push(id);
	}
	let stale = false;
	for (let i = 0; i < missing.length; i += CHUNK) {
		const chunk = missing.slice(i, i + CHUNK);
		try {
			const body = await once(`latest|${chunk.join(',')}`, () =>
				usgsGet('collections/latest-continuous/items', {
					monitoring_location_id: chunk.join(','),
					parameter_code: `${DISCHARGE},${STAGE}`,
					properties: 'monitoring_location_id,parameter_code,value,time',
					limit: chunk.length * 4
				})
			);
			const parsed = parseLatest(body?.features ?? []);
			for (const id of chunk) {
				const v = parsed.get(id) ?? { ...EMPTY_LATEST };
				latestCache.set(id, v);
				data.set(id, v);
			}
		} catch (e) {
			if (!(e instanceof UsgsError)) throw e;
			stale = true;
			if (e.code === 'rate_limited') break; // no point trying the remaining chunks
		}
	}
	for (const id of unique) if (!data.has(id)) data.set(id, { ...EMPTY_LATEST });
	return { data, stale };
}

/** Whatever is cached right now for these sites; never touches the network. */
export function peekLatest(ids: string[]): Map<string, Latest> {
	const out = new Map<string, Latest>();
	for (const id of ids) {
		const hit = latestCache.get(id);
		if (hit) out.set(id, hit.v);
	}
	return out;
}

// ── 24-hour series ─────────────────────────────────────────────────────────────

const MAX_POINTS = 120;

function downsample(points: [number, number][]): [number, number][] {
	if (points.length <= MAX_POINTS) return points;
	const step = points.length / MAX_POINTS;
	const out: [number, number][] = [];
	for (let i = 0; i < MAX_POINTS; i++) out.push(points[Math.floor(i * step)]);
	out.push(points[points.length - 1]);
	return out;
}

function parseSeries(features: any[]): Map<string, Series | null> {
	const by = new Map<string, Record<string, [number, number][]>>();
	for (const f of features) {
		const p = f?.properties;
		const v = num(p?.value);
		const t = Date.parse(p?.time);
		if (typeof p?.monitoring_location_id !== 'string' || v === null || !Number.isFinite(t)) continue;
		if (p.parameter_code !== DISCHARGE && p.parameter_code !== STAGE) continue;
		const rec = by.get(p.monitoring_location_id) ?? {};
		(rec[p.parameter_code] ??= []).push([t, v]);
		by.set(p.monitoring_location_id, rec);
	}
	const out = new Map<string, Series | null>();
	for (const [id, rec] of by) {
		const pick = (rec[DISCHARGE]?.length ?? 0) >= 3 ? DISCHARGE : (rec[STAGE]?.length ?? 0) >= 3 ? STAGE : null;
		out.set(id, pick ? { param: pick, points: downsample(rec[pick]!.sort((a, b) => a[0] - b[0])) } : null);
	}
	return out;
}

/** Last-24-hours series (discharge, else stage) for the given sites, one USGS request for all. */
export async function getSeries(ids: string[], hours = 24): Promise<{ data: Map<string, Series | null>; stale: boolean }> {
	const unique = [...new Set(ids)];
	const data = new Map<string, Series | null>();
	const missing: string[] = [];
	for (const id of unique) {
		const hit = seriesCache.get(id);
		if (hit) data.set(id, hit.v);
		if (!hit?.fresh) missing.push(id);
	}
	let stale = false;
	for (let i = 0; i < missing.length; i += 25) {
		const chunk = missing.slice(i, i + 25);
		try {
			const end = new Date();
			const start = new Date(end.getTime() - hours * 3600_000);
			const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
			const body = await once(`series|${hours}|${chunk.join(',')}`, () =>
				usgsGet('collections/continuous/items', {
					monitoring_location_id: chunk.join(','),
					parameter_code: `${DISCHARGE},${STAGE}`,
					time: `${iso(start)}/${iso(end)}`,
					properties: 'monitoring_location_id,parameter_code,time,value',
					limit: chunk.length * 400
				})
			);
			const parsed = parseSeries(body?.features ?? []);
			for (const id of chunk) {
				const v = parsed.get(id) ?? null;
				seriesCache.set(id, v);
				data.set(id, v);
			}
		} catch (e) {
			if (!(e instanceof UsgsError)) throw e;
			stale = true;
			if (e.code === 'rate_limited') break;
		}
	}
	for (const id of unique) if (!data.has(id)) data.set(id, null);
	return { data, stale };
}

export function peekSeries(ids: string[]): Map<string, Series | null> {
	const out = new Map<string, Series | null>();
	for (const id of ids) {
		const hit = seriesCache.get(id);
		if (hit) out.set(id, hit.v);
	}
	return out;
}

/** Rising / falling / steady versus roughly three hours earlier. */
export function trendOf(series: Series | null | undefined): Trend | null {
	if (!series || series.points.length < 2) return null;
	const pts = series.points;
	const [tNow, vNow] = pts[pts.length - 1];
	const target = tNow - 3 * 3600_000;
	let ref: [number, number] | null = null;
	for (const p of pts) {
		if (p[0] <= target + 30 * 60_000) ref = p; // latest point at/before ~3h ago (30 min grace)
	}
	if (!ref || tNow - ref[0] < 90 * 60_000) return null;
	const delta = vNow - ref[1];
	const threshold = series.param === STAGE ? 0.1 : Math.max(Math.abs(ref[1]) * 0.03, 1);
	if (delta > threshold) return 'rising';
	if (delta < -threshold) return 'falling';
	return 'steady';
}

// ── Sites ──────────────────────────────────────────────────────────────────────

/** One monitoring location by id (cached 24 h). null if it doesn't exist or isn't a stream site. */
export async function getSite(siteId: string): Promise<Gauge | null> {
	if (!/^USGS-\d{8,15}$/.test(siteId)) return null;
	const hit = siteCache.get(siteId);
	if (hit?.fresh) return hit.v;
	try {
		const body = await once(`site|${siteId}`, () => usgsGet(`collections/monitoring-locations/items/${siteId}`, {}));
		const g = body?.properties?.site_type_code === 'ST' ? toGauge(body) : null;
		siteCache.set(siteId, g);
		return g;
	} catch (e) {
		if (e instanceof UsgsError && hit) return hit.v;
		throw e;
	}
}

export interface FoundGauge extends Gauge {
	latest: Latest;
}

const bySiteNumber = (a: Gauge, b: Gauge) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0);

/**
 * Active stream gauges on the river named by `raw`, grouped by river and ordered by USGS station
 * number (USGS numbers stations in downstream order within a basin, so this reads roughly upstream
 * to downstream). "Active" = reported discharge or gauge height within the last 7 days.
 */
export async function searchGauges(raw: string): Promise<{ gauges: FoundGauge[]; truncated: boolean; stale: boolean }> {
	const q = parseQuery(raw);
	if (!q) throw new RangeError('query too short');
	const cacheKey = `${q.kind}|${q.base}`;
	let sites = searchCache.get(cacheKey);
	if (!sites?.fresh) {
		try {
			const body = await once(`search|${cacheKey}`, () =>
				usgsGet('collections/monitoring-locations/items', {
					filter: buildNameFilter(q),
					'filter-lang': 'cql-text',
					properties: 'id,monitoring_location_name,state_name,site_type_code',
					limit: SEARCH_LIMIT
				})
			);
			const features: any[] = body?.features ?? [];
			const gauges = features.map(toGauge).filter((g): g is Gauge => !!g && matchKind(g.name, q) !== null);
			sites = { v: { gauges, truncated: features.length >= SEARCH_LIMIT }, fresh: true };
			searchCache.set(cacheKey, sites.v);
		} catch (e) {
			if (!(e instanceof UsgsError) || !sites) throw e;
		}
	}
	const { gauges, truncated } = sites.v;
	const { data, stale } = await getLatest(gauges.map((g) => g.siteId));
	const cutoff = Date.now() - ACTIVE_WITHIN_MS;
	const active: FoundGauge[] = [];
	for (const g of gauges) {
		const latest = data.get(g.siteId) ?? EMPTY_LATEST;
		const newest = Math.max(
			latest.discharge ? Date.parse(latest.discharge.time) : 0,
			latest.stage ? Date.parse(latest.stage.time) : 0
		);
		if (newest >= cutoff) active.push({ ...g, latest });
	}
	const exact = (g: Gauge) => (matchKind(g.name, q) === 'exact' ? 0 : 1);
	active.sort((a, b) => exact(a) - exact(b) || a.river.localeCompare(b.river) || bySiteNumber(a, b));
	return { gauges: active, truncated, stale: stale || !sites.fresh };
}
