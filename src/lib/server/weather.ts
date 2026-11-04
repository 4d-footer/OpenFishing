/**
 * Current conditions + a 48-hour strip (24 h back, 24 h ahead) for My Waters tiles, from Open-Meteo
 * (free, no key). One request covers every tile; results are cached per ~1 km cell for 15 minutes and an
 * older copy is served if Open-Meteo is unreachable.
 */
import { TtlCache } from '#lib/server/usgs.js';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const TTL = 15 * 60_000;
const TIMEOUT_MS = 8_000;
const CHUNK = 50;

export type PressureTrend = 'rising' | 'falling' | 'steady';

export interface Weather {
	time: number; // epoch ms of the reading
	tempF: number | null;
	feelsF: number | null;
	humidity: number | null;
	pressureInHg: number | null;
	pressureTrend: PressureTrend | null; // versus about three hours earlier
	windMph: number | null;
	windDir: number | null; // degrees the wind blows FROM
	gustMph: number | null;
	cloud: number | null; // %
	precipIn: number | null; // in the last hour
	code: number | null; // WMO weather code
	isDay: boolean;
	hourly: { t: number[]; tempF: number[]; pressureInHg: number[]; windMph: number[] };
}

const cache = new TtlCache<Weather | null>(TTL, 1000);
const inflight = new Map<string, Promise<unknown>>();

export function resetWeatherState(): void {
	cache.clear();
	inflight.clear();
}

const cell = (lat: number, lng: number) => `${lat.toFixed(2)},${lng.toFixed(2)}`;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const HPA_TO_INHG = 0.02953;

export function parseWeather(j: any, now = Date.now()): Weather | null {
	const c = j?.current;
	if (!c || typeof c !== 'object') return null;
	const times: number[] = Array.isArray(j.hourly?.time) ? j.hourly.time.map((t: unknown) => (typeof t === 'number' ? t * 1000 : NaN)) : [];
	const col = (k: string): (number | null)[] => (Array.isArray(j.hourly?.[k]) ? j.hourly[k].map(num) : []);
	const hT = col('temperature_2m'), hP = col('pressure_msl'), hW = col('wind_speed_10m');
	const t: number[] = [], tempF: number[] = [], pressureInHg: number[] = [], windMph: number[] = [];
	for (let i = 0; i < times.length; i++) {
		if (!Number.isFinite(times[i]) || hT[i] === null || hP[i] === null) continue;
		t.push(times[i]);
		tempF.push(hT[i] as number);
		pressureInHg.push((hP[i] as number) * HPA_TO_INHG);
		windMph.push(hW[i] ?? 0);
	}
	const pNow = num(c.pressure_msl);
	let trend: PressureTrend | null = null;
	if (pNow !== null) {
		// the hourly sample closest to three hours ago
		let best = -1, bd = Infinity;
		for (let i = 0; i < times.length; i++) {
			const d = Math.abs(times[i] - (now - 3 * 3600_000));
			if (hP[i] !== null && d < bd) { bd = d; best = i; }
		}
		if (best >= 0 && bd <= 2 * 3600_000) {
			const delta = pNow - (hP[best] as number);
			trend = delta >= 1 ? 'rising' : delta <= -1 ? 'falling' : 'steady';
		}
	}
	const ct = typeof c.time === 'number' ? c.time * 1000 : now;
	return {
		time: ct,
		tempF: num(c.temperature_2m),
		feelsF: num(c.apparent_temperature),
		humidity: num(c.relative_humidity_2m),
		pressureInHg: pNow === null ? null : pNow * HPA_TO_INHG,
		pressureTrend: trend,
		windMph: num(c.wind_speed_10m),
		windDir: num(c.wind_direction_10m),
		gustMph: num(c.wind_gusts_10m),
		cloud: num(c.cloud_cover),
		precipIn: num(c.precipitation),
		code: num(c.weather_code),
		isDay: c.is_day === 1 || c.is_day === true,
		hourly: { t, tempF, pressureInHg, windMph }
	};
}

async function fetchCells(cells: { lat: number; lng: number }[]): Promise<(Weather | null)[]> {
	const url = new URL(OPEN_METEO_URL);
	url.searchParams.set('latitude', cells.map((c) => c.lat.toFixed(2)).join(','));
	url.searchParams.set('longitude', cells.map((c) => c.lng.toFixed(2)).join(','));
	url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,weather_code,is_day');
	url.searchParams.set('hourly', 'temperature_2m,pressure_msl,wind_speed_10m');
	url.searchParams.set('temperature_unit', 'fahrenheit');
	url.searchParams.set('wind_speed_unit', 'mph');
	url.searchParams.set('precipitation_unit', 'inch');
	url.searchParams.set('past_hours', '24');
	url.searchParams.set('forecast_hours', '24');
	url.searchParams.set('timeformat', 'unixtime');
	let res: Response;
	try {
		res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch {
		throw new Error('weather unavailable');
	}
	if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
	const body = await res.json();
	const list: any[] = Array.isArray(body) ? body : [body];
	return cells.map((_, i) => parseWeather(list[i]));
}

/** Weather for each point (keyed by its id). `stale` is set when some cells came from an older copy. */
export async function getWeather(
	points: { id: string; lat: number | null; lng: number | null }[]
): Promise<{ data: Map<string, Weather | null>; stale: boolean }> {
	const data = new Map<string, Weather | null>();
	const need = new Map<string, { lat: number; lng: number }>();
	for (const p of points) {
		if (p.lat === null || p.lng === null || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) { data.set(p.id, null); continue; }
		const key = cell(p.lat, p.lng);
		const hit = cache.get(key);
		if (hit) data.set(p.id, hit.v);
		if (!hit?.fresh) need.set(key, { lat: Number(p.lat.toFixed(2)), lng: Number(p.lng.toFixed(2)) });
	}
	let stale = false;
	const keys = [...need.keys()];
	for (let i = 0; i < keys.length; i += CHUNK) {
		const chunk = keys.slice(i, i + CHUNK);
		try {
			const out = await (inflight.get(chunk.join('|')) as Promise<(Weather | null)[]> | undefined ??
				(() => {
					const p = fetchCells(chunk.map((k) => need.get(k)!)).finally(() => inflight.delete(chunk.join('|')));
					inflight.set(chunk.join('|'), p);
					return p;
				})());
			chunk.forEach((k, j) => cache.set(k, out[j]));
		} catch {
			stale = true;
		}
	}
	for (const p of points) {
		if (p.lat === null || p.lng === null || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
		const hit = cache.get(cell(p.lat, p.lng));
		data.set(p.id, hit ? hit.v : null);
	}
	return { data, stale };
}
