import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEnv: Record<string, string | undefined> = {};
vi.mock('#lib/server/env.js', () => ({ env: mockEnv }));

const u = await import('../usgs');

const site = (id: string, name: string, state = 'Missouri', lng = -91, lat = 38) => ({
	type: 'Feature',
	id,
	properties: { id, monitoring_location_name: name, state_name: state, site_type_code: 'ST' },
	geometry: { type: 'Point', coordinates: [lng, lat] }
});
const row = (id: string, param: string, value: string | number, time: string) => ({
	properties: { monitoring_location_id: id, parameter_code: param, value: String(value), time }
});
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

let calls: URL[];
let headers: Record<string, string>[];
let handler: (url: URL) => Response | Promise<Response>;
const ok = (features: unknown[]) => new Response(JSON.stringify({ features }), { status: 200 });

beforeEach(() => {
	u.resetUsgsState();
	for (const k of Object.keys(mockEnv)) delete mockEnv[k];
	calls = [];
	headers = [];
	handler = () => ok([]);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: URL | string, init?: RequestInit) => {
			const url = new URL(String(input));
			calls.push(url);
			headers.push((init?.headers ?? {}) as Record<string, string>);
			return handler(url);
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

describe('parseQuery', () => {
	it.each([
		['Missouri River', { base: 'MISSOURI', kind: 'RIVER' }],
		['missouri', { base: 'MISSOURI', kind: 'RIVER' }],
		['Missouri R', { base: 'MISSOURI', kind: 'RIVER' }],
		['  Little   Missouri  ', { base: 'LITTLE MISSOURI', kind: 'RIVER' }],
		['Fall Creek', { base: 'FALL', kind: 'CREEK' }],
		['Clear Cr.', { base: 'CLEAR', kind: 'CREEK' }],
		['North Fork', { base: 'NORTH', kind: 'FORK' }],
		["St. Croix River", { base: 'ST. CROIX', kind: 'RIVER' }]
	])('%s', (raw, want) => expect(u.parseQuery(raw)).toEqual(want));

	it.each(['', '  ', 'ab', 'R', 'x'.repeat(41), '%%%', 'river'])('rejects %j', (raw) => {
		expect(u.parseQuery(raw)).toBeNull();
	});

	it('strips wildcard and quote characters that could alter the filter', () => {
		const q = u.parseQuery("Mis%sou_ri\\ ';--")!;
		expect(q.base).not.toMatch(/[%_\;]/);
	});
});

describe('buildNameFilter', () => {
	it('is case-insensitive, stream-only, and covers R/RIVER spellings', () => {
		const f = u.buildNameFilter(u.parseQuery('Missouri River')!);
		expect(f).toContain("site_type_code = 'ST'");
		expect(f).toContain("CASEI(monitoring_location_name) LIKE CASEI('%missouri river %')");
		expect(f).toContain("CASEI(monitoring_location_name) LIKE CASEI('%missouri r %')");
		expect(f).toContain("CASEI('%missouri r,%')");
	});
	it('covers St. spelling variants', () => {
		const f = u.buildNameFilter(u.parseQuery('St Croix')!);
		expect(f).toContain('%st croix river %');
		expect(f).toContain('%st. croix river %');
	});
	it('doubles single quotes', () => {
		const f = u.buildNameFilter({ base: "O'BRIEN", kind: 'RIVER' });
		expect(f).toContain("o''brien");
	});
});

describe('river labels', () => {
	it.each([
		['MISSOURI R NO. 7 NR TRENTON, ND', 'Missouri River'],
		['MISSOURI RIVER NO. 4 NEAR NOHLY, MT', 'Missouri River'],
		['Missouri River at Hermann, MO', 'Missouri River'],
		['LITTLE MISSOURI RIVER NEAR WATFORD CITY, ND', 'Little Missouri River'],
		['ST. CROIX RIVER AT ST. CROIX FALLS, WI', 'St. Croix River'],
		['SOUTH FK CLEAR CR AB DAM NR TOWN', 'South Fork Clear Creek'],
		['Fall Creek at Ithaca NY', 'Fall Creek']
	])('%s → %s', (name, label) => expect(u.riverLabel(name)).toBe(label));
});

describe('searchGauges', () => {
	const sites = [
		site('USGS-06934500', 'Missouri River at Hermann, MO'),
		site('USGS-06935965', 'MISSOURI RIVER AT ST. CHARLES, MO'),
		site('USGS-06332500', 'MISSOURI RIVER AT SANISH, ND', 'North Dakota'),
		site('USGS-06335000', 'LITTLE MISSOURI RIVER NEAR WATFORD CITY, ND', 'North Dakota'),
		site('USGS-06999999', 'MISSOURI RIVER TRIBUTARY NEAR X, MO'), // not this river
		site('USGS-06888888', 'MISSOURI RIVER AT DEAD, MO') // inactive
	];
	function api(url: URL) {
		if (url.pathname.endsWith('/monitoring-locations/items')) return ok(sites);
		if (url.pathname.endsWith('/latest-continuous/items')) {
			return ok([
				row('USGS-06934500', '00060', 54500, iso(20 * 60_000)),
				row('USGS-06934500', '00065', 6.27, iso(20 * 60_000)),
				row('USGS-06935965', '00065', 10.15, iso(30 * 60_000)), // stage only
				row('USGS-06332500', '00060', 3100, iso(10 * 60_000)),
				row('USGS-06335000', '00060', 120, iso(15 * 60_000)),
				row('USGS-06888888', '00060', 5, iso(30 * 24 * 3600_000)) // 30 days old
			]);
		}
		return ok([]);
	}

	it('lists the exact river first (by station number), then related rivers, active gauges only', async () => {
		handler = api;
		const r = await u.searchGauges('Missouri River');
		// Not included: the tributary ("... TRIBUTARY") and the gauge with no recent reading.
		expect(r.gauges.map((g) => g.siteId)).toEqual([
			'USGS-06332500', // Missouri River
			'USGS-06934500',
			'USGS-06935965',
			'USGS-06335000' // Little Missouri River, a separate group after the exact match
		]);
		expect(r.gauges.map((g) => g.river)).toEqual(['Missouri River', 'Missouri River', 'Missouri River', 'Little Missouri River']);
		expect(r.gauges[1].latest.discharge?.value).toBe(54500);
		expect(r.gauges[2].latest.discharge).toBeNull();
		expect(r.gauges[2].latest.stage?.value).toBe(10.15);
		expect(r.gauges[0].state).toBe('North Dakota');
		expect(r.truncated).toBe(false);
		expect(r.stale).toBe(false);
	});

	it('sends the CQL filter, requested fields and no key header by default', async () => {
		handler = api;
		await u.searchGauges('Missouri River');
		const first = calls[0];
		expect(first.pathname).toBe('/ogcapi/v1/collections/monitoring-locations/items');
		expect(first.searchParams.get('filter-lang')).toBe('cql-text');
		expect(first.searchParams.get('filter')).toContain('CASEI');
		expect(first.searchParams.get('limit')).toBe('500');
		expect(headers[0]['X-Api-Key']).toBeUndefined();
	});

	it('sends the API key header and honours USGS_API_URL', async () => {
		mockEnv.USGS_API_KEY = 'k123';
		mockEnv.USGS_API_URL = 'http://mock.test/ogcapi/v1/';
		handler = api;
		await u.searchGauges('Missouri River');
		expect(calls[0].origin).toBe('http://mock.test');
		expect(headers[0]['X-Api-Key']).toBe('k123');
	});

	it('serves a repeat search from cache without calling USGS', async () => {
		handler = api;
		await u.searchGauges('Missouri River');
		const n = calls.length;
		await u.searchGauges('missouri');
		expect(calls.length).toBe(n);
	});

	it('flags truncated results', async () => {
		handler = (url) => (url.pathname.endsWith('/monitoring-locations/items') ? ok(Array.from({ length: 500 }, (_, i) => site(`USGS-0${6000000 + i}`, `MISSOURI RIVER AT S${i}`))) : ok([]));
		expect((await u.searchGauges('Missouri River')).truncated).toBe(true);
	});

	it('rejects an unusable query without calling USGS', async () => {
		await expect(u.searchGauges('ab')).rejects.toBeInstanceOf(RangeError);
		expect(calls.length).toBe(0);
	});

	it('maps network failure and bad status to "unavailable"', async () => {
		handler = () => new Response('nope', { status: 503 });
		await expect(u.searchGauges('Missouri River')).rejects.toMatchObject({ code: 'unavailable' });
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
		await expect(u.searchGauges('Platte River')).rejects.toMatchObject({ code: 'unavailable' });
	});
});

describe('rate limiting', () => {
	it('backs off after a 429 and stops calling USGS', async () => {
		handler = () => new Response('slow down', { status: 429 });
		await expect(u.searchGauges('Missouri River')).rejects.toMatchObject({ code: 'rate_limited' });
		const n = calls.length;
		await expect(u.searchGauges('Platte River')).rejects.toMatchObject({ code: 'rate_limited' });
		expect(calls.length).toBe(n);
	});

	it('latest readings fall back to the cache and report stale during a back-off', async () => {
		handler = () => ok([row('USGS-06934500', '00060', 1000, iso(60_000))]);
		const first = await u.getLatest(['USGS-06934500']);
		expect(first.stale).toBe(false);
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 6 * 60_000); // cache expired
		handler = () => new Response('x', { status: 429 });
		const again = await u.getLatest(['USGS-06934500']);
		vi.useRealTimers();
		expect(again.stale).toBe(true);
		expect(again.data.get('USGS-06934500')?.discharge?.value).toBe(1000);
	});
});

describe('getLatest', () => {
	it('batches in chunks of 100 and caches per site', async () => {
		handler = (url) => ok((url.searchParams.get('monitoring_location_id') ?? '').split(',').map((id) => row(id, '00060', 1, iso(1000))));
		const ids = Array.from({ length: 230 }, (_, i) => `USGS-${String(10000000 + i)}`);
		await u.getLatest(ids);
		expect(calls.length).toBe(3);
		await u.getLatest(ids);
		expect(calls.length).toBe(3);
	});

	it('gives sites with no rows empty readings and caches that too', async () => {
		handler = () => ok([]);
		const r = await u.getLatest(['USGS-06934500']);
		expect(r.data.get('USGS-06934500')).toEqual({ discharge: null, stage: null });
		await u.getLatest(['USGS-06934500']);
		expect(calls.length).toBe(1);
	});

	it('ignores non-numeric values (ice, equipment malfunction) and keeps the newest row', async () => {
		handler = () => ok([
			row('USGS-06934500', '00060', 'Ice', iso(1000)),
			row('USGS-06934500', '00060', 100, iso(60_000)),
			row('USGS-06934500', '00060', 200, iso(10_000))
		]);
		expect((await u.getLatest(['USGS-06934500'])).data.get('USGS-06934500')?.discharge?.value).toBe(200);
	});

	it('peekLatest never calls USGS', async () => {
		expect(u.peekLatest(['USGS-06934500']).size).toBe(0);
		handler = () => ok([row('USGS-06934500', '00060', 5, iso(1000))]);
		await u.getLatest(['USGS-06934500']);
		calls.length = 0;
		expect(u.peekLatest(['USGS-06934500']).get('USGS-06934500')?.discharge?.value).toBe(5);
		expect(calls.length).toBe(0);
	});
});

describe('getSeries', () => {
	const pts = (id: string, param: string, n: number, base = 100) =>
		Array.from({ length: n }, (_, i) => row(id, param, base + i, iso((n - i) * 15 * 60_000)));

	it('requests one 24h window for all sites and prefers discharge', async () => {
		handler = () => ok([...pts('USGS-A0000001', '00060', 20), ...pts('USGS-A0000001', '00065', 20, 5), ...pts('USGS-B0000002', '00065', 10, 5)]);
		const r = await u.getSeries(['USGS-A0000001', 'USGS-B0000002']);
		expect(calls.length).toBe(1);
		expect(calls[0].searchParams.get('monitoring_location_id')).toBe('USGS-A0000001,USGS-B0000002');
		const [from, to] = calls[0].searchParams.get('time')!.split('/');
		expect(Date.parse(to) - Date.parse(from)).toBe(24 * 3600_000);
		expect(r.data.get('USGS-A0000001')?.param).toBe('00060');
		expect(r.data.get('USGS-B0000002')?.param).toBe('00065');
		expect(r.data.get('USGS-A0000001')!.points[0][0]).toBeLessThan(r.data.get('USGS-A0000001')!.points.at(-1)![0]);
	});

	it('returns null for sites without enough points and caches the result', async () => {
		handler = () => ok(pts('USGS-A0000001', '00060', 2));
		expect((await u.getSeries(['USGS-A0000001', 'USGS-C0000003'])).data.get('USGS-A0000001')).toBeNull();
		await u.getSeries(['USGS-A0000001', 'USGS-C0000003']);
		expect(calls.length).toBe(1);
	});

	it('downsamples very long series', async () => {
		handler = () => ok(pts('USGS-A0000001', '00060', 400));
		expect((await u.getSeries(['USGS-A0000001'])).data.get('USGS-A0000001')!.points.length).toBeLessThanOrEqual(121);
	});
});

describe('getRangeSeries', () => {
	const pts = (n: number, param = '00060', step = 15 * 60_000) =>
		Array.from({ length: n }, (_, i) => row('USGS-A0000001', param, 100 + i, iso((n - i) * step)));

	it.each([24, 48, 72, 168])('asks for exactly the %i-hour window with room for 5-minute data', async (h) => {
		handler = () => ok(pts(20));
		const r = await u.getRangeSeries('USGS-A0000001', h);
		const [from, to] = calls[0].searchParams.get('time')!.split('/');
		expect(Date.parse(to) - Date.parse(from)).toBe(h * 3600_000);
		expect(Number(calls[0].searchParams.get('limit'))).toBeGreaterThanOrEqual(h * 12 * 2);
		expect(r.series?.param).toBe('00060');
		expect(r.stale).toBe(false);
	});

	it('keeps more detail than the 24h tile series, but still bounds it', async () => {
		handler = () => ok(pts(2000, '00060', 5 * 60_000));
		const n = (await u.getRangeSeries('USGS-A0000001', 168)).series!.points.length;
		expect(n).toBeGreaterThan(121);
		expect(n).toBeLessThanOrEqual(241);
	});

	it('caches per site and window', async () => {
		handler = () => ok(pts(20));
		await u.getRangeSeries('USGS-A0000001', 48);
		await u.getRangeSeries('USGS-A0000001', 48);
		expect(calls.length).toBe(1);
		await u.getRangeSeries('USGS-A0000001', 72);
		expect(calls.length).toBe(2);
	});

	it('returns null series when the site has too little data', async () => {
		handler = () => ok(pts(2));
		expect((await u.getRangeSeries('USGS-A0000001', 24)).series).toBeNull();
	});

	it('throws when USGS fails and nothing is cached; serves the old copy (stale) when something is', async () => {
		handler = () => new Response('', { status: 500 });
		await expect(u.getRangeSeries('USGS-A0000001', 24)).rejects.toBeInstanceOf(u.UsgsError);
		handler = () => ok(pts(20));
		await u.getRangeSeries('USGS-A0000001', 24);
		vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] });
		handler = () => new Response('', { status: 500 });
		const r = await u.getRangeSeries('USGS-A0000001', 24);
		vi.useRealTimers();
		expect(r.stale).toBe(true);
		expect(r.series?.points.length).toBe(20);
	});
});

describe('extra readings (water temperature and friends)', () => {
	it('getLatest asks for the extra parameters and returns only the ones the gauge reports', async () => {
		handler = () => ok([
			row('USGS-A0000001', '00060', 88, iso(60_000)), row('USGS-A0000001', '00065', 1.5, iso(60_000)),
			row('USGS-A0000001', '00010', 13.5, iso(120_000)), row('USGS-A0000001', '00400', 8.1, iso(120_000)),
			row('USGS-B0000002', '00060', 5, iso(60_000))
		]);
		const { data } = await u.getLatest(['USGS-A0000001', 'USGS-B0000002']);
		const codes = calls[0].searchParams.get('parameter_code')!.split(',');
		expect(codes).toEqual(expect.arrayContaining(['00060', '00065', '00010', '00095', '00300', '00400', '63680']));
		expect(data.get('USGS-A0000001')!.extra).toEqual({ '00010': { value: 13.5, time: expect.any(String) }, '00400': { value: 8.1, time: expect.any(String) } });
		expect(data.get('USGS-B0000002')!.extra).toBeUndefined();
	});

	it('getRangeSeries returns one named parameter, and rejects unknown ones without a request', async () => {
		handler = () => ok(Array.from({ length: 10 }, (_, i) => row('USGS-A0000001', '00010', 10 + i / 10, iso((10 - i) * 900_000))));
		const r = await u.getRangeSeries('USGS-A0000001', 48, '00010');
		expect(calls[0].searchParams.get('parameter_code')).toBe('00010');
		expect(r.series).toMatchObject({ param: '00010' });
		expect(r.series!.points).toHaveLength(10);
		expect((await u.getRangeSeries('USGS-A0000001', 48, '99999')).series).toBeNull();
		expect(calls).toHaveLength(1);
	});

	it('caches each parameter separately', async () => {
		handler = () => ok(Array.from({ length: 5 }, (_, i) => row('USGS-A0000001', '00010', 10 + i, iso((5 - i) * 900_000))));
		await u.getRangeSeries('USGS-A0000001', 24, '00010');
		await u.getRangeSeries('USGS-A0000001', 24, '00010');
		expect(calls.length).toBe(1);
		await u.getRangeSeries('USGS-A0000001', 24, '00300');
		expect(calls.length).toBe(2);
	});
});

describe('trendOf', () => {
	const series = (vals: number[], param: '00060' | '00065' = '00060') => ({
		param,
		points: vals.map((v, i) => [Date.now() - (vals.length - 1 - i) * 30 * 60_000, v] as [number, number])
	});
	it('detects rising, falling and steady flow over ~3h', () => {
		expect(u.trendOf(series([1000, 1000, 1000, 1000, 1000, 1000, 1200]))).toBe('rising');
		expect(u.trendOf(series([1200, 1100, 1100, 1100, 1100, 1100, 1000]))).toBe('falling');
		expect(u.trendOf(series([1000, 1005, 1000, 1002, 1000, 1001, 1010]))).toBe('steady');
	});
	it('uses an absolute threshold for stage', () => {
		expect(u.trendOf(series([5, 5, 5, 5, 5, 5, 5.3], '00065'))).toBe('rising');
		expect(u.trendOf(series([5, 5, 5, 5, 5, 5, 5.05], '00065'))).toBe('steady');
	});
	it('needs enough history', () => {
		expect(u.trendOf(null)).toBeNull();
		expect(u.trendOf(series([1000]))).toBeNull();
		expect(u.trendOf(series([1000, 1500, 2000]))).toBeNull(); // only 1h of data
	});
});

describe('getSite', () => {
	it('rejects malformed ids without calling USGS', async () => {
		expect(await u.getSite('06934500')).toBeNull();
		expect(await u.getSite('USGS-1; drop')).toBeNull();
		expect(calls.length).toBe(0);
	});
	it('returns a stream site and caches it', async () => {
		handler = () => new Response(JSON.stringify(site('USGS-06934500', 'Missouri River at Hermann, MO')), { status: 200 });
		const g = await u.getSite('USGS-06934500');
		expect(g).toMatchObject({ siteId: 'USGS-06934500', number: '06934500', river: 'Missouri River', state: 'Missouri', lat: 38, lng: -91 });
		await u.getSite('USGS-06934500');
		expect(calls.length).toBe(1);
		expect(calls[0].pathname).toBe('/ogcapi/v1/collections/monitoring-locations/items/USGS-06934500');
	});
	it('returns null for non-stream sites and for unknown ids', async () => {
		const well = site('USGS-380000091000001', 'WELL 1');
		well.properties.site_type_code = 'GW';
		handler = () => new Response(JSON.stringify(well), { status: 200 });
		expect(await u.getSite('USGS-380000091000001')).toBeNull();
		handler = () => new Response(JSON.stringify({ code: 'NotFound' }), { status: 200 });
		expect(await u.getSite('USGS-00000000')).toBeNull();
	});
});
