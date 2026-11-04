import { describe, it, expect, vi, beforeEach } from 'vitest';

// A real SQLite database with the project's actual migrations, so ownership, ordering and the
// unique index are exercised for real (not through mocked query chains).
vi.mock('#lib/server/db/index.js', async () => {
	const { default: Database } = await import('better-sqlite3');
	const { drizzle } = await import('drizzle-orm/better-sqlite3');
	const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
	const schema = await import('#lib/server/db/schema.js');
	const client = new Database(':memory:');
	const db = drizzle(client, { schema });
	migrate(db, { migrationsFolder: 'drizzle' });
	return { db, client };
});

const mockGetSite = vi.fn();
const mockGetLatest = vi.fn();
const mockGetSeries = vi.fn();
const mockSearch = vi.fn();
const mockRange = vi.fn();
const mockForecast = vi.fn();
vi.mock('#lib/server/usgs.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/usgs.js')>()),
	getSite: mockGetSite,
	getLatest: mockGetLatest,
	getSeries: mockGetSeries,
	searchGauges: mockSearch,
	getRangeSeries: mockRange
}));
vi.mock('#lib/server/forecast.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/forecast.js')>()),
	getForecast: mockForecast
}));

const { db } = await import('#lib/server/db/index.js');
const schema = await import('#lib/server/db/schema.js');
const { UsgsError } = await import('#lib/server/usgs.js');
const { resetSearchThrottle, MAX_GAUGES } = await import('#lib/server/waters.js');
const save = (await import('../api/waters/+server')).POST;
const del = (await import('../api/waters/[id]/+server')).DELETE;
const data = (await import('../api/waters/data/+server')).GET;
const search = (await import('../api/waters/search/+server')).GET;
const history = (await import('../api/waters/[id]/history/+server')).GET;
const forecastRoute = (await import('../api/waters/[id]/forecast/+server')).GET;
const { ForecastError } = await import('#lib/server/forecast.js');
const pageLoad = (await import('../waters/+page.server')).load;

const A = { user: { id: 'user-a' } } as any;
const B = { user: { id: 'user-b' } } as any;
const OPEN = { user: null } as any;

const gauge = (n: number, extra: object = {}) => ({
	siteId: `USGS-0${6000000 + n}`, number: `0${6000000 + n}`, name: `MISSOURI RIVER AT S${n}`,
	river: 'Missouri River', state: 'Missouri', lat: 38.5, lng: -91.5, ...extra
});
const post = (locals: any, body: unknown) =>
	save({ request: new Request('http://x/api/waters', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), locals } as any) as Promise<Response>;
const get = (fn: any, locals: any, qs = '') => fn({ url: new URL('http://x/?' + qs), locals } as any) as Promise<Response>;

beforeEach(async () => {
	await db.delete(schema.waterGauge);
	await db.delete(schema.user);
	for (const id of ['user-a', 'user-b']) {
		await db.insert(schema.user).values({ id, username: id, passwordHash: 'x', email: `${id}@t.test` });
	}
	resetSearchThrottle();
	mockGetSite.mockReset().mockImplementation(async (id: string) => gauge(Number(id.slice(-7)) - 6000000, { siteId: id }));
	mockGetLatest.mockReset().mockResolvedValue({ data: new Map(), stale: false });
	mockGetSeries.mockReset().mockResolvedValue({ data: new Map(), stale: false });
	mockSearch.mockReset();
	mockRange.mockReset();
	mockForecast.mockReset();
});

describe('POST /api/waters (follow a gauge)', () => {
	it('saves a gauge using USGS details, not client-supplied ones', async () => {
		mockGetSite.mockResolvedValue(gauge(1));
		const res = await post(A, { siteId: 'USGS-06000001', name: 'EVIL', lat: 0, lng: 0 });
		expect(res.status).toBe(201);
		const { gauge: g } = await res.json();
		expect(g).toMatchObject({ siteId: 'USGS-06000001', name: 'MISSOURI RIVER AT S1', river: 'Missouri River', lat: 38.5 });
		expect(g.usgsUrl).toBe('https://waterdata.usgs.gov/monitoring-location/06000001/');
		const rows = await db.select().from(schema.waterGauge);
		expect(rows).toHaveLength(1);
		expect(rows[0].userId).toBe('user-a');
	});

	it.each([['not json'], [{}], [{ siteId: 5 }], [{ siteId: '06934500' }], [{ siteId: "USGS-1'; DROP" }], [{ siteId: 'USGS-123' }]])('rejects %j', async (body) => {
		expect((await post(A, body)).status).toBe(400);
		expect(mockGetSite).not.toHaveBeenCalled();
	});

	it('404s for a site USGS does not know (or that is not a stream)', async () => {
		mockGetSite.mockResolvedValue(null);
		expect((await post(A, { siteId: 'USGS-06000009' })).status).toBe(404);
		expect(await db.select().from(schema.waterGauge)).toHaveLength(0);
	});

	it('409s on a duplicate, but another user may follow the same gauge', async () => {
		expect((await post(A, { siteId: 'USGS-06000001' })).status).toBe(201);
		expect((await post(A, { siteId: 'USGS-06000001' })).status).toBe(409);
		expect((await post(B, { siteId: 'USGS-06000001' })).status).toBe(201);
	});

	it('detects duplicates in open mode too (null owner)', async () => {
		expect((await post(OPEN, { siteId: 'USGS-06000001' })).status).toBe(201);
		expect((await post(OPEN, { siteId: 'USGS-06000001' })).status).toBe(409);
		expect((await db.select().from(schema.waterGauge))[0].userId).toBeNull();
	});

	it('enforces the per-user limit', async () => {
		for (let i = 1; i <= MAX_GAUGES; i++) expect((await post(A, { siteId: `USGS-0${6000000 + i}` })).status).toBe(201);
		const res = await post(A, { siteId: 'USGS-06009999' });
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({ error: 'limit', max: MAX_GAUGES });
		expect((await post(B, { siteId: 'USGS-06009999' })).status).toBe(201); // limit is per user
	});

	it('appends new gauges in order', async () => {
		for (const n of [3, 1, 2]) await post(A, { siteId: `USGS-0${6000000 + n}` });
		const order = (await db.select().from(schema.waterGauge)).sort((x, y) => x.sortOrder - y.sortOrder).map((r) => r.siteId);
		expect(order).toEqual(['USGS-06000003', 'USGS-06000001', 'USGS-06000002']);
	});

	it('maps USGS trouble to 503 / 429 and saves nothing', async () => {
		mockGetSite.mockRejectedValue(new UsgsError('unavailable'));
		expect((await post(A, { siteId: 'USGS-06000001' })).status).toBe(503);
		mockGetSite.mockRejectedValue(new UsgsError('rate_limited'));
		expect((await post(A, { siteId: 'USGS-06000001' })).status).toBe(429);
		expect(await db.select().from(schema.waterGauge)).toHaveLength(0);
	});
});

describe('DELETE /api/waters/:id', () => {
	const del1 = (locals: any, id: string) => del({ params: { id }, locals } as any) as Promise<Response>;

	it("removes the user's own gauge", async () => {
		const { gauge: g } = await (await post(A, { siteId: 'USGS-06000001' })).json();
		expect((await del1(A, g.id)).status).toBe(200);
		expect(await db.select().from(schema.waterGauge)).toHaveLength(0);
	});

	it("404s for another user's gauge and leaves it alone", async () => {
		const { gauge: g } = await (await post(A, { siteId: 'USGS-06000001' })).json();
		expect((await del1(B, g.id)).status).toBe(404);
		expect(await db.select().from(schema.waterGauge)).toHaveLength(1);
	});

	it('404s for an unknown id', async () => {
		expect((await del1(A, 'nope')).status).toBe(404);
	});
});

describe('GET /api/waters/data', () => {
	it('returns an empty list without calling USGS when nothing is followed', async () => {
		const body = await (await get(data, A)).json();
		expect(body.gauges).toEqual([]);
		expect(mockGetLatest).not.toHaveBeenCalled();
	});

	it("returns only the caller's gauges, with readings, series and trend", async () => {
		await post(A, { siteId: 'USGS-06000001' });
		await post(B, { siteId: 'USGS-06000002' });
		const now = Date.now();
		const points: [number, number][] = Array.from({ length: 8 }, (_, i) => [now - (7 - i) * 30 * 60_000, i === 7 ? 1300 : 1000]);
		mockGetLatest.mockResolvedValue({ data: new Map([['USGS-06000001', { discharge: { value: 1300, time: new Date(now).toISOString() }, stage: null }]]), stale: false });
		mockGetSeries.mockResolvedValue({ data: new Map([['USGS-06000001', { param: '00060', points }]]), stale: true });
		const res = await get(data, A);
		expect(res.headers.get('cache-control')).toContain('no-store');
		const body = await res.json();
		expect(body.gauges.map((g: any) => g.siteId)).toEqual(['USGS-06000001']);
		expect(mockGetLatest).toHaveBeenCalledWith(['USGS-06000001']);
		expect(body.gauges[0].latest.discharge.value).toBe(1300);
		expect(body.gauges[0].trend).toBe('rising');
		expect(body.gauges[0].series.points).toHaveLength(8);
		expect(body.stale).toBe(true);
	});
});

describe('GET /api/waters/search', () => {
	it('400s on an unusable query without calling USGS', async () => {
		expect((await get(search, A, 'q=ab')).status).toBe(400);
		expect((await get(search, A, '')).status).toBe(400);
		expect(mockSearch).not.toHaveBeenCalled();
	});

	it('marks gauges the user already follows', async () => {
		await post(A, { siteId: 'USGS-06000001' });
		mockSearch.mockResolvedValue({ gauges: [{ ...gauge(1), latest: { discharge: null, stage: null } }, { ...gauge(2), latest: { discharge: null, stage: null } }], truncated: false, stale: false });
		const body = await (await get(search, A, 'q=missouri river')).json();
		expect(body.gauges.map((g: any) => [g.siteId, g.saved])).toEqual([['USGS-06000001', true], ['USGS-06000002', false]]);
		expect(body.truncated).toBe(false);
	});

	it("does not mark another user's gauges as saved", async () => {
		await post(B, { siteId: 'USGS-06000001' });
		mockSearch.mockResolvedValue({ gauges: [{ ...gauge(1), latest: { discharge: null, stage: null } }], truncated: false, stale: false });
		expect((await (await get(search, A, 'q=missouri')).json()).gauges[0].saved).toBe(false);
	});

	it('maps USGS trouble to 503 / 429', async () => {
		mockSearch.mockRejectedValue(new UsgsError('unavailable'));
		expect((await get(search, A, 'q=missouri')).status).toBe(503);
		mockSearch.mockRejectedValue(new UsgsError('rate_limited'));
		expect((await get(search, A, 'q=missouri')).status).toBe(429);
	});

	it('throttles a user who searches too fast, per user', async () => {
		mockSearch.mockResolvedValue({ gauges: [], truncated: false, stale: false });
		for (let i = 0; i < 20; i++) expect((await get(search, A, 'q=missouri')).status).toBe(200);
		const res = await get(search, A, 'q=missouri');
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: 'too_many' });
		expect((await get(search, B, 'q=missouri')).status).toBe(200);
	});
});

describe('/waters page load', () => {
	it('returns saved gauges without touching USGS, plus the limit', async () => {
		await post(A, { siteId: 'USGS-06000001' });
		const out: any = await pageLoad({ locals: A } as any);
		expect(out.max).toBe(MAX_GAUGES);
		expect(out.gauges.map((g: any) => g.siteId)).toEqual(['USGS-06000001']);
		expect(out.gauges[0].latest).toBeNull();
		expect(mockGetLatest).not.toHaveBeenCalled();
	});
	it("does not show other users' gauges", async () => {
		await post(B, { siteId: 'USGS-06000001' });
		expect(((await pageLoad({ locals: A } as any)) as any).gauges).toEqual([]);
	});
});

describe('GET /api/waters/:id/history and /forecast', () => {
	const call = (fn: any, locals: any, id: string, qs = '') => fn({ params: { id }, url: new URL('http://x/?' + qs), locals } as any) as Promise<Response>;
	const follow = async (locals: any, n = 1) => (await (await post(locals, { siteId: `USGS-0${6000000 + n}` })).json()).gauge.id as string;

	it.each([['hours=5'], ['hours=abc'], ['']])('history rejects %j', async (qs) => {
		const id = await follow(A);
		expect((await call(history, A, id, qs)).status).toBe(400);
		expect(mockRange).not.toHaveBeenCalled();
	});

	it.each([24, 48, 72, 168])('history returns the %i-hour series for the gauge\'s site', async (h) => {
		const id = await follow(A);
		mockRange.mockResolvedValue({ series: { param: '00060', points: [[1, 2]] }, stale: false });
		const res = await call(history, A, id, `hours=${h}`);
		expect(res.status).toBe(200);
		expect(mockRange).toHaveBeenCalledWith('USGS-06000001', h, undefined);
		expect(await res.json()).toMatchObject({ hours: h, series: { param: '00060' }, stale: false });
	});

	it("history and forecast 404 for another user's gauge or an unknown id, without calling out", async () => {
		const id = await follow(B);
		for (const [fn, qs] of [[history, 'hours=24'], [forecastRoute, '']] as const) {
			expect((await call(fn, A, id, qs)).status).toBe(404);
			expect((await call(fn, A, 'nope', qs)).status).toBe(404);
		}
		expect(mockRange).not.toHaveBeenCalled();
		expect(mockForecast).not.toHaveBeenCalled();
	});

	it.each(['00010', '00065', '00300'])('history passes a supported parameter (%s) through', async (param) => {
		const id = await follow(A);
		mockRange.mockResolvedValue({ series: { param, points: [[1, 2]] }, stale: false });
		const res = await call(history, A, id, `hours=48&param=${param}`);
		expect(mockRange).toHaveBeenCalledWith('USGS-06000001', 48, param);
		expect((await res.json()).param).toBe(param);
	});

	it.each(['99999', 'abc', "00060;drop"])('history rejects an unknown parameter %j', async (param) => {
		const id = await follow(A);
		expect((await call(history, A, id, `hours=24&param=${encodeURIComponent(param)}`)).status).toBe(400);
		expect(mockRange).not.toHaveBeenCalled();
	});

	it('history maps USGS trouble to 503 / 429', async () => {
		const id = await follow(A);
		mockRange.mockRejectedValue(new UsgsError('unavailable'));
		expect((await call(history, A, id, 'hours=24')).status).toBe(503);
		mockRange.mockRejectedValue(new UsgsError('rate_limited'));
		expect((await call(history, A, id, 'hours=24')).status).toBe(429);
	});

	it('forecast passes the gauge location, returns the forecast, and is never cached by the browser', async () => {
		const id = await follow(A);
		mockForecast.mockResolvedValue({ forecast: { source: 'nws', issuedAt: null, lid: 'X', series: { '00060': [[1, 2]] } }, stale: false });
		const res = await call(forecastRoute, A, id);
		expect(mockForecast).toHaveBeenCalledWith('USGS-06000001', 38.5, -91.5);
		expect(res.headers.get('cache-control')).toContain('no-store');
		expect((await res.json()).forecast.source).toBe('nws');
	});

	it('forecast returns null when none exists, and 503 when NOAA is down', async () => {
		const id = await follow(A);
		mockForecast.mockResolvedValue({ forecast: null, stale: false });
		expect(await (await call(forecastRoute, A, id)).json()).toEqual({ forecast: null, stale: false });
		mockForecast.mockRejectedValue(new ForecastError('unavailable'));
		expect((await call(forecastRoute, A, id)).status).toBe(503);
	});
});
