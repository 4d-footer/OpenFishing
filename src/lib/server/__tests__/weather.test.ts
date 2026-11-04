import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWeather, parseWeather, resetWeatherState } from '#lib/server/weather.js';

const NOW = Date.now();
const H = 3600;
const body = (over: Record<string, unknown> = {}, pressureNow = 1013) => ({
	current: { time: Math.floor(NOW / 1000), temperature_2m: 48.2, apparent_temperature: 44, relative_humidity_2m: 71, pressure_msl: pressureNow, wind_speed_10m: 6.4, wind_direction_10m: 270, wind_gusts_10m: 14, cloud_cover: 40, precipitation: 0, weather_code: 2, is_day: 1, ...over },
	hourly: {
		time: Array.from({ length: 49 }, (_, i) => Math.floor(NOW / 1000) + (i - 24) * H),
		temperature_2m: Array.from({ length: 49 }, (_, i) => 40 + i / 4),
		pressure_msl: Array.from({ length: 49 }, () => 1013),
		wind_speed_10m: Array.from({ length: 49 }, () => 5)
	}
});

let calls: URL[];
let respond: (u: URL) => Response;
beforeEach(() => {
	resetWeatherState();
	calls = [];
	respond = (u) => {
		const n = u.searchParams.get('latitude')!.split(',').length;
		return new Response(JSON.stringify(n === 1 ? body() : Array.from({ length: n }, () => body())), { status: 200 });
	};
	vi.stubGlobal('fetch', async (u: URL | string) => { const url = new URL(String(u)); calls.push(url); return respond(url); });
});
afterEach(() => vi.unstubAllGlobals());

describe('parseWeather', () => {
	it('reads current conditions in US units and the 48 h strip', () => {
		const w = parseWeather(body(), NOW)!;
		expect(w).toMatchObject({ tempF: 48.2, feelsF: 44, humidity: 71, windMph: 6.4, windDir: 270, gustMph: 14, cloud: 40, code: 2, isDay: true });
		expect(w.pressureInHg).toBeCloseTo(1013 * 0.02953, 3);
		expect(w.hourly.t).toHaveLength(49);
		expect(w.hourly.pressureInHg[0]).toBeCloseTo(29.9, 1);
	});
	it.each([[1013, 'steady'], [1016, 'rising'], [1010, 'falling'], [1013.9, 'steady'], [1014, 'rising']])('pressure %s hPa vs 1013 three hours ago is %s', (p, want) => {
		expect(parseWeather(body({}, p as number), NOW)!.pressureTrend).toBe(want);
	});
	it('returns null without a current block, and tolerates missing fields', () => {
		expect(parseWeather({}, NOW)).toBeNull();
		expect(parseWeather(null, NOW)).toBeNull();
		const w = parseWeather({ current: { time: 1 } }, NOW)!;
		expect(w.tempF).toBeNull();
		expect(w.pressureTrend).toBeNull();
		expect(w.hourly.t).toEqual([]);
	});
	it('is night when is_day is 0', () => expect(parseWeather(body({ is_day: 0 }), NOW)!.isDay).toBe(false));
});

describe('getWeather', () => {
	it('asks once for every place, in US units, with 24 h either side', async () => {
		const r = await getWeather([{ id: 'a', lat: 39.5823, lng: -78.3097 }, { id: 'b', lat: 45.297, lng: -111.211 }]);
		expect(calls).toHaveLength(1);
		const q = calls[0].searchParams;
		expect(q.get('latitude')).toBe('39.58,45.30');
		expect(q.get('longitude')).toBe('-78.31,-111.21');
		expect(q.get('temperature_unit')).toBe('fahrenheit');
		expect(q.get('wind_speed_unit')).toBe('mph');
		expect(q.get('past_hours')).toBe('24');
		expect(q.get('forecast_hours')).toBe('24');
		expect(r.data.get('a')?.tempF).toBe(48.2);
		expect(r.data.get('b')?.tempF).toBe(48.2);
	});
	it('shares one cell between nearby places and caches for later calls', async () => {
		await getWeather([{ id: 'a', lat: 39.581, lng: -78.309 }, { id: 'b', lat: 39.584, lng: -78.311 }]);
		expect(calls[0].searchParams.get('latitude')).toBe('39.58');
		await getWeather([{ id: 'a', lat: 39.581, lng: -78.309 }]);
		expect(calls).toHaveLength(1);
	});
	it('maps places without a location to null and does not call out for them', async () => {
		const r = await getWeather([{ id: 'x', lat: null, lng: null }]);
		expect(r.data.get('x')).toBeNull();
		expect(calls).toHaveLength(0);
	});
	it('serves the older copy, marked stale, when Open-Meteo fails after the cache expired', async () => {
		await getWeather([{ id: 'a', lat: 39.58, lng: -78.31 }]);
		respond = () => new Response('', { status: 500 });
		vi.useFakeTimers({ now: Date.now() + 16 * 60_000, toFake: ['Date'] });
		const r = await getWeather([{ id: 'a', lat: 39.58, lng: -78.31 }]);
		vi.useRealTimers();
		expect(r.stale).toBe(true);
		expect(r.data.get('a')?.tempF).toBe(48.2);
	});
	it('returns null (and stale) when it fails with nothing cached', async () => {
		respond = () => new Response('', { status: 500 });
		const r = await getWeather([{ id: 'a', lat: 39.58, lng: -78.31 }]);
		expect(r.stale).toBe(true);
		expect(r.data.get('a')).toBeNull();
	});
});
