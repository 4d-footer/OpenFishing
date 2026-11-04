import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getForecast, parseNwsForecast, parseNwmSeries, resetForecastState, ForecastError } from '#lib/server/forecast.js';

const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

const nwsBody = (n = 8, extra: object = {}) => ({
	forecast: {
		issuedTime: iso(now - H),
		primaryUnits: 'ft',
		secondaryUnits: 'kcfs',
		data: Array.from({ length: n }, (_, i) => ({ validTime: iso(now + i * 6 * H), primary: 5 + i, secondary: 50 + i })),
		...extra
	}
});
const nwmBody = (hours: number, key = 'shortRange') => ({
	reach: { reachId: '1' },
	[key]: { series: { referenceTime: iso(now), units: 'ft³/s', data: Array.from({ length: hours }, (_, i) => ({ validTime: iso(now + (i + 1) * H), flow: 300 + i })) } }
});

let routes: Record<string, () => { status?: number; body?: unknown; throws?: boolean }>;
const calls: string[] = [];
beforeEach(() => {
	resetForecastState();
	calls.length = 0;
	routes = {};
	vi.stubGlobal('fetch', async (u: URL | string) => {
		const url = String(u);
		calls.push(url);
		const key = Object.keys(routes).find((k) => url.includes(k));
		if (!key) return new Response('{}', { status: 404 });
		const r = routes[key]();
		if (r.throws) throw new Error('network');
		return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('parseNwsForecast', () => {
	it('converts kcfs to cfs and keeps ascending future points', () => {
		const f = parseNwsForecast(nwsBody(), 'GLGM8')!;
		expect(f).toMatchObject({ source: 'nws', param: '00060', lid: 'GLGM8' });
		expect(f.points[0][1]).toBe(50_000);
		expect(f.points).toHaveLength(8);
		expect(f.points.every((p, i, a) => i === 0 || a[i - 1][0] < p[0])).toBe(true);
	});
	it('falls back to stage when flow is -999', () => {
		const body = nwsBody();
		body.forecast.data.forEach((r) => (r.secondary = -999));
		const f = parseNwsForecast(body, 'X')!;
		expect(f.param).toBe('00065');
		expect(f.points[0][1]).toBe(5);
	});
	it('accepts cfs units as-is', () => {
		expect(parseNwsForecast(nwsBody(8, { secondaryUnits: 'cfs' }), 'X')!.points[0][1]).toBe(50);
	});
	it('returns null for an empty forecast, too few points, or the zero issue time', () => {
		expect(parseNwsForecast({ forecast: { issuedTime: '0001-01-01T00:00:00Z', data: [] } }, 'X')).toBeNull();
		expect(parseNwsForecast(nwsBody(2), 'X')).toBeNull();
		expect(parseNwsForecast({}, 'X')).toBeNull();
		expect(parseNwsForecast(nwsBody(8, { issuedTime: '0001-01-01T00:00:00Z' }), 'X')!.issuedAt).toBeNull();
	});
	it('drops points more than 3 hours in the past', () => {
		const body = nwsBody(8);
		body.forecast.data[0].validTime = iso(now - 12 * H);
		expect(parseNwsForecast(body, 'X')!.points).toHaveLength(7);
	});
});

describe('parseNwmSeries', () => {
	it('reads the short-range series', () => {
		const s = parseNwmSeries(nwmBody(18))!;
		expect(s.points).toHaveLength(18);
		expect(s.points[0][1]).toBe(300);
		expect(s.issuedAt).toBeTruthy();
	});
	it('picks the longest of several model series, whatever the nesting', () => {
		const body = { ...nwmBody(18), mediumRange: { member1: { referenceTime: iso(now), units: 'ft³/s', data: Array.from({ length: 100 }, (_, i) => ({ validTime: iso(now + (i + 1) * 3 * H), flow: 10 + i })) } } };
		expect(parseNwmSeries(body)!.points).toHaveLength(100);
	});
	it('converts cubic metres per second', () => {
		const body = { shortRange: { series: { units: 'm³/s', data: [1, 2, 3].map((v, i) => ({ validTime: iso(now + (i + 1) * H), flow: v })) } } };
		expect(parseNwmSeries(body)!.points[0][1]).toBeCloseTo(35.3147, 3);
	});
	it('returns null for empty or malformed bodies', () => {
		expect(parseNwmSeries({ shortRange: {}, mediumRange: {} })).toBeNull();
		expect(parseNwmSeries(null)).toBeNull();
		expect(parseNwmSeries({ shortRange: { series: { data: [{ validTime: 'x', flow: 'y' }] } } })).toBeNull();
	});
});

describe('getForecast', () => {
	const nwsRoutes = () => {
		routes['/gauges?bbox'] = () => ({ body: { gauges: [{ lid: 'FARM8', latitude: 46, longitude: -112 }, { lid: 'GLGM8', latitude: 45.4972, longitude: -111.2708 }] } });
		routes['/gauges/FARM8/'] = () => ({ body: {} });
		routes['/gauges/FARM8'] = () => ({ body: { lid: 'FARM8', usgsId: '99999999' } });
		routes['/gauges/GLGM8/stageflow'] = () => ({ body: nwsBody() });
		routes['/gauges/GLGM8'] = () => ({ body: { lid: 'GLGM8', usgsId: '06043500' } });
	};

	it('uses the NWS forecast when the USGS id matches an NWS gauge (nearest candidates checked by usgsId)', async () => {
		nwsRoutes();
		const { forecast, stale } = await getForecast('USGS-06043500', 45.4972, -111.2708);
		expect(stale).toBe(false);
		expect(forecast).toMatchObject({ source: 'nws', lid: 'GLGM8', param: '00060' });
		expect(calls.some((c) => c.includes('/nldi/') || c.includes('/reaches/'))).toBe(false);
	});

	it('falls back to the National Water Model through the NLDI comid', async () => {
		routes['/gauges?bbox'] = () => ({ body: { gauges: [] } });
		routes['/nwissite/USGS-06043120'] = () => ({ body: { features: [{ properties: { comid: 3855837 } }] } });
		routes['/reaches/3855837/streamflow?series=medium_range_blend'] = () => ({ body: {} });
		routes['/reaches/3855837/streamflow?series=medium_range'] = () => ({ body: {} });
		routes['/reaches/3855837/streamflow'] = () => ({ body: nwmBody(18) });
		const { forecast } = await getForecast('USGS-06043120', 45.297, -111.211);
		expect(forecast).toMatchObject({ source: 'nwm', lid: null, param: '00060' });
		expect(forecast!.points).toHaveLength(18);
	});

	it('falls back to the model when the NWS gauge has an empty forecast', async () => {
		nwsRoutes();
		routes['/gauges/GLGM8/stageflow'] = () => ({ body: { forecast: { issuedTime: '0001-01-01T00:00:00Z', data: [] } } });
		routes['/nwissite/USGS-06043500'] = () => ({ body: { features: [{ properties: { comid: 3855315 } }] } });
		routes['/reaches/3855315/streamflow'] = () => ({ body: nwmBody(18) });
		expect((await getForecast('USGS-06043500', 45.4972, -111.2708)).forecast?.source).toBe('nwm');
	});

	it('returns null when there is no NWS gauge and no model reach', async () => {
		routes['/gauges?bbox'] = () => ({ body: { gauges: [] } });
		routes['/nwissite/'] = () => ({ status: 404 });
		expect((await getForecast('USGS-06043120', 45.2, -111.2)).forecast).toBeNull();
	});

	it('remembers "no forecast" for only a few minutes (the model feed is empty between runs)', async () => {
		routes['/gauges?bbox'] = () => ({ body: { gauges: [] } });
		routes['/nwissite/USGS-06043120'] = () => ({ body: { features: [{ properties: { comid: 3855837 } }] } });
		routes['/reaches/3855837/streamflow'] = () => ({ body: { shortRange: {}, mediumRange: {} } });
		expect((await getForecast('USGS-06043120', 45.2, -111.2)).forecast).toBeNull();
		const n = calls.length;
		await getForecast('USGS-06043120', 45.2, -111.2);
		expect(calls.length).toBe(n); // still inside the 5 minutes
		routes['/reaches/3855837/streamflow'] = () => ({ body: nwmBody(18) });
		vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ['Date'] });
		const later = await getForecast('USGS-06043120', 45.2, -111.2);
		vi.useRealTimers();
		expect(later.forecast?.source).toBe('nwm');
	});

	it('rejects a malformed site id without any request', async () => {
		expect((await getForecast('USGS-abc', 1, 1)).forecast).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('caches, so a second look-up makes no requests', async () => {
		nwsRoutes();
		await getForecast('USGS-06043500', 45.4972, -111.2708);
		const n = calls.length;
		await getForecast('USGS-06043500', 45.4972, -111.2708);
		expect(calls.length).toBe(n);
	});

	it('remembers "no NWS gauge" so the search is not repeated', async () => {
		routes['/gauges?bbox'] = () => ({ body: { gauges: [] } });
		routes['/nwissite/'] = () => ({ status: 404 });
		await getForecast('USGS-06043120', 45.2, -111.2);
		vi.useFakeTimers({ now: Date.now() + 31 * 60_000, toFake: ['Date'] }); // forecast expired, lookups not
		await getForecast('USGS-06043120', 45.2, -111.2);
		vi.useRealTimers();
		expect(calls.filter((c) => c.includes('/gauges?bbox')).length).toBe(1);
	});

	it('throws ForecastError when NOAA is down and nothing is cached', async () => {
		routes['/gauges?bbox'] = () => ({ throws: true });
		await expect(getForecast('USGS-06043500', 45.4972, -111.2708)).rejects.toBeInstanceOf(ForecastError);
	});

	it('serves the old copy, marked stale, when NOAA fails after the cache expired', async () => {
		nwsRoutes();
		await getForecast('USGS-06043500', 45.4972, -111.2708);
		routes['/gauges/GLGM8/stageflow'] = () => ({ status: 500 });
		vi.useFakeTimers({ now: Date.now() + 31 * 60_000, toFake: ['Date'] });
		const r = await getForecast('USGS-06043500', 45.4972, -111.2708);
		vi.useRealTimers();
		expect(r.stale).toBe(true);
		expect(r.forecast?.source).toBe('nws');
	});
});
