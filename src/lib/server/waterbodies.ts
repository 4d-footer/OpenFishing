/**
 * Named lakes, reservoirs and ponds (no flow gauge needed) from USGS The National Map:
 *  - GNIS "Other Hydrographic Features" (point per named lake/reservoir, with state and county), and
 *  - NHD waterbody polygons, which also hold big lakes the point layer lacks (e.g. Flathead Lake).
 * A waterbody is stored as `GNIS-<feature id>`; both datasets use the GNIS id.
 */
import { TtlCache } from '#lib/server/usgs.js';

export const GNIS_URL = 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/7/query';
export const NHD_URL = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/10/query';
export const TIGER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0/query';
const TIMEOUT_MS = 10_000;
const GNIS_LIMIT = 100;
const NHD_LIMIT = 60;
const MAX_STATE_LOOKUPS = 10;
const SEARCH_TTL = 60 * 60_000;
const SITE_TTL = 24 * 3600_000;

export type WaterKind = 'lake' | 'reservoir' | 'pond';

export interface Waterbody {
	siteId: string; // "GNIS-1559164"
	name: string;
	kind: WaterKind;
	state: string | null; // full name, to match USGS gauges ("West Virginia")
	county: string | null;
	lat: number;
	lng: number;
	areaKm2: number | null;
}

export class WaterbodyError extends Error {
	constructor(public detail = '') {
		super(`unavailable${detail ? ': ' + detail : ''}`);
	}
}

export const STATES: Record<string, string> = {
	AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
	DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
	KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
	MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
	NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
	PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
	VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
	PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa', MP: 'Northern Mariana Islands'
};
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([a, n]) => [n.toUpperCase(), a]));

const searchCache = new TtlCache<{ items: Waterbody[]; truncated: boolean }>(SEARCH_TTL, 200);
const siteCache = new TtlCache<Waterbody | null>(SITE_TTL, 1000);
const stateCache = new TtlCache<string | null>(30 * 24 * 3600_000, 5000);
const inflight = new Map<string, Promise<unknown>>();

export function resetWaterbodyState(): void {
	searchCache.clear();
	siteCache.clear();
	stateCache.clear();
	inflight.clear();
}

function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const running = inflight.get(key) as Promise<T> | undefined;
	if (running) return running;
	const p = fn().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

async function arcgis(url: string, params: Record<string, string | number>): Promise<any> {
	const u = new URL(url);
	u.searchParams.set('f', 'json');
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	let res: Response;
	try {
		res = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch (e) {
		throw new WaterbodyError(`${u.host} ${(e as Error)?.name ?? 'error'}`);
	}
	if (!res.ok) throw new WaterbodyError(`${u.host} HTTP ${res.status}`);
	let body: any;
	try {
		body = await res.json();
	} catch {
		throw new WaterbodyError(`${u.host} bad JSON`);
	}
	if (body?.error) throw new WaterbodyError(`${u.host} ${body.error.code ?? 'error'}`);
	return body;
}

// ── Query parsing ───────────────────────────────────────────────────────────────

const TYPE_WORDS = new Set(['LAKE', 'POND', 'RESERVOIR', 'RES', 'LAGOON', 'LAKES', 'PONDS']);

export interface ParsedWaterQuery {
	tokens: string[]; // upper case, without the type words
	state: string | null; // two-letter code
	exact: string; // normalized full name typed, for ranking
}

/** "Mud Lake, MT" → tokens [MUD], state MT. Null when there is nothing specific enough to search. */
export function parseWaterQuery(raw: string): ParsedWaterQuery | null {
	let text = String(raw ?? '').toUpperCase();
	let state: string | null = null;
	const comma = text.lastIndexOf(',');
	if (comma >= 0) {
		const tail = text.slice(comma + 1).replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
		const code = tail.length === 2 && STATES[tail] ? tail : (STATE_BY_NAME.get(tail) ?? null);
		if (code) { state = code; text = text.slice(0, comma); }
	}
	const clean = text.replace(/[^A-Z0-9 .'-]/g, ' ').replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
	if (!clean || clean.length > 50) return null;
	const words = clean.split(' ').filter(Boolean);
	const tokens = words.filter((w) => !TYPE_WORDS.has(w) && w !== 'ST' && w.length >= 1);
	if (tokens.join('').replace(/[^A-Z]/g, '').length < 3) return null;
	return { tokens, state, exact: words.join(' ') };
}

const esc = (s: string) => s.replace(/'/g, "''");
const nameClause = (col: string, tokens: string[]) => tokens.map((t) => `UPPER(${col}) LIKE '%${esc(t)}%'`).join(' AND ');

// ── Mapping ─────────────────────────────────────────────────────────────────────

const kindOf = (name: string, cls: string): WaterKind => (/\bponds?\b/i.test(name) ? 'pond' : /reservoir/i.test(cls) ? 'reservoir' : 'lake');

function gnisToWaterbody(f: any): Waterbody | null {
	const a = f?.attributes;
	const x = Number(f?.geometry?.x), y = Number(f?.geometry?.y);
	if (!a || !Number.isFinite(x) || !Number.isFinite(y) || !a.gaz_id || !a.gaz_name) return null;
	return {
		siteId: `GNIS-${a.gaz_id}`,
		name: String(a.gaz_name),
		kind: kindOf(String(a.gaz_name), String(a.gaz_featureclass)),
		state: STATES[String(a.state_alpha)] ?? null,
		county: a.county_name ? String(a.county_name) : null,
		lat: y,
		lng: x,
		areaKm2: null
	};
}

/** Centroid of the biggest ring of an ArcGIS polygon (shoelace). */
export function polygonCentroid(geometry: any): { lat: number; lng: number } | null {
	const rings: number[][][] = Array.isArray(geometry?.rings) ? geometry.rings : [];
	let best: { area: number; cx: number; cy: number } | null = null;
	for (const r of rings) {
		if (r.length < 3) continue;
		let a = 0, cx = 0, cy = 0;
		for (let i = 0; i < r.length - 1; i++) {
			const [x0, y0] = r[i], [x1, y1] = r[i + 1];
			const k = x0 * y1 - x1 * y0;
			a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
		}
		a /= 2;
		if (Math.abs(a) < 1e-12) continue;
		const c = { area: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a) };
		if (!best || c.area > best.area) best = c;
	}
	return best && Number.isFinite(best.cx) && Number.isFinite(best.cy) ? { lat: best.cy, lng: best.cx } : null;
}

async function stateAt(lat: number, lng: number): Promise<string | null> {
	const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
	const hit = stateCache.get(key);
	if (hit?.fresh) return hit.v;
	try {
		const body = await arcgis(TIGER_URL, { geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: 'NAME', returnGeometry: 'false' });
		const name = body?.features?.[0]?.attributes?.NAME;
		const v = typeof name === 'string' && name ? name : null;
		stateCache.set(key, v);
		return v;
	} catch {
		return hit ? hit.v : null; // a missing state is not fatal
	}
}

async function nhdToWaterbody(f: any): Promise<Waterbody | null> {
	const a = f?.attributes;
	const c = polygonCentroid(f?.geometry);
	if (!a?.GNIS_ID || !a.GNIS_NAME || !c) return null;
	return {
		siteId: `GNIS-${a.GNIS_ID}`,
		name: String(a.GNIS_NAME),
		kind: kindOf(String(a.GNIS_NAME), String(a.FTYPE)),
		state: await stateAt(c.lat, c.lng),
		county: null,
		lat: c.lat,
		lng: c.lng,
		areaKm2: typeof a.AREASQKM === 'number' ? a.AREASQKM : null
	};
}

const rank = (w: Waterbody, q: ParsedWaterQuery) => {
	const n = w.name.toUpperCase();
	return n === q.exact ? 0 : n.startsWith(q.exact) ? 1 : 2;
};

// ── Search ──────────────────────────────────────────────────────────────────────

export async function searchWaterbodies(raw: string): Promise<{ items: Waterbody[]; truncated: boolean }> {
	const q = parseWaterQuery(raw);
	if (!q) return { items: [], truncated: false };
	const key = `${q.tokens.join(' ')}|${q.state ?? ''}`;
	const hit = searchCache.get(key);
	if (hit?.fresh) return hit.v;
	try {
		const result = await once(`wb|${key}`, async () => {
			const stateClause = q.state ? ` AND state_alpha='${q.state}'` : '';
			const g = await arcgis(GNIS_URL, {
				where: `gaz_featureclass IN ('Lake','Reservoir') AND ${nameClause('gaz_name', q.tokens)}${stateClause}`,
				outFields: 'gaz_id,gaz_name,gaz_featureclass,state_alpha,county_name',
				returnGeometry: 'true',
				outSR: 4326,
				orderByFields: 'gaz_name',
				resultRecordCount: GNIS_LIMIT
			});
			const found = new Map<string, Waterbody>();
			for (const f of g?.features ?? []) {
				const w = gnisToWaterbody(f);
				if (w) found.set(w.siteId, w);
			}
			let truncated = (g?.features?.length ?? 0) >= GNIS_LIMIT || g?.exceededTransferLimit === true;

			// Big lakes are polygons in NHD and may be missing above. Only worth it for a specific query.
			if (!truncated) {
				try {
					const n = await arcgis(NHD_URL, {
						where: nameClause('GNIS_NAME', q.tokens),
						outFields: 'GNIS_ID,GNIS_NAME,FTYPE,AREASQKM',
						returnGeometry: 'true',
						outSR: 4326,
						maxAllowableOffset: 0.01,
						resultRecordCount: NHD_LIMIT
					});
					const extra = new Map<string, any>();
					for (const f of n?.features ?? []) {
						const id = `GNIS-${f?.attributes?.GNIS_ID}`;
						if (found.has(id)) continue;
						const prev = extra.get(id);
						if (!prev || (f.attributes.AREASQKM ?? 0) > (prev.attributes.AREASQKM ?? 0)) extra.set(id, f);
					}
					const todo = [...extra.values()].slice(0, MAX_STATE_LOOKUPS);
					if (extra.size > MAX_STATE_LOOKUPS) truncated = true;
					for (const w of await Promise.all(todo.map(nhdToWaterbody))) {
						if (!w) continue;
						if (q.state && w.state !== STATES[q.state]) continue;
						found.set(w.siteId, w);
					}
				} catch {
					/* the point layer alone is still a useful answer */
				}
			}
			return { items: [...found.values()], truncated };
		});
		result.items.sort((a, b) => rank(a, q) - rank(b, q) || a.name.localeCompare(b.name) || (a.state ?? '').localeCompare(b.state ?? ''));
		searchCache.set(key, result);
		return result;
	} catch (e) {
		if (hit) return hit.v;
		throw e;
	}
}

// ── One waterbody by id (used when following, so the client's name/location are never trusted) ──

export async function getWaterbody(siteId: string): Promise<Waterbody | null> {
	const m = /^GNIS-(\d{1,9})$/.exec(siteId);
	if (!m) return null;
	const id = m[1];
	const hit = siteCache.get(siteId);
	if (hit?.fresh) return hit.v;
	try {
		const w = await once(`wbs|${id}`, async () => {
			const g = await arcgis(GNIS_URL, {
				where: `gaz_id=${id} AND gaz_featureclass IN ('Lake','Reservoir')`,
				outFields: 'gaz_id,gaz_name,gaz_featureclass,state_alpha,county_name',
				returnGeometry: 'true',
				outSR: 4326,
				resultRecordCount: 1
			});
			const fromGnis = g?.features?.[0] ? gnisToWaterbody(g.features[0]) : null;
			if (fromGnis) return fromGnis;
			const n = await arcgis(NHD_URL, {
				where: `GNIS_ID='${id}'`,
				outFields: 'GNIS_ID,GNIS_NAME,FTYPE,AREASQKM',
				returnGeometry: 'true',
				outSR: 4326,
				maxAllowableOffset: 0.01,
				resultRecordCount: 5
			});
			const biggest = [...(n?.features ?? [])].sort((a: any, b: any) => (b.attributes?.AREASQKM ?? 0) - (a.attributes?.AREASQKM ?? 0))[0];
			return biggest ? await nhdToWaterbody(biggest) : null;
		});
		siteCache.set(siteId, w);
		return w;
	} catch (e) {
		if (hit) return hit.v;
		throw e;
	}
}
