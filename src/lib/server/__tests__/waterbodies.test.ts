import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseWaterQuery, searchWaterbodies, getWaterbody, polygonCentroid, resetWaterbodyState, WaterbodyError } from '#lib/server/waterbodies.js';

const gnis = (id: number, name: string, cls: string, st: string, county: string, x: number, y: number) => ({ attributes: { gaz_id: id, gaz_name: name, gaz_featureclass: cls, state_alpha: st, county_name: county }, geometry: { x, y } });
const square = (cx: number, cy: number, d = 0.1) => ({ rings: [[[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]]] });
const nhd = (id: string, name: string, area: number, cx: number, cy: number, ftype = 'LakePond') => ({ attributes: { GNIS_ID: id, GNIS_NAME: name, FTYPE: ftype, AREASQKM: area }, geometry: square(cx, cy) });

let calls: URL[];
let handler: (u: URL) => unknown | Response;
beforeEach(() => {
	resetWaterbodyState();
	calls = [];
	handler = () => ({ features: [] });
	vi.stubGlobal('fetch', async (u: URL | string) => {
		const url = new URL(String(u)); calls.push(url);
		const r = handler(url);
		return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
	});
});
afterEach(() => vi.unstubAllGlobals());
const hosts = () => calls.map((c) => c.host);

describe('parseWaterQuery', () => {
	it.each([
		['Mud Lake', ['MUD'], null],
		['mud lake, MT', ['MUD'], 'MT'],
		['Flathead', ['FLATHEAD'], null],
		['Fort Peck Lake', ['FORT', 'PECK'], null],
		['Lake Mead, Nevada', ['MEAD'], 'NV'],
		['Cacapon State Park Lake', ['CACAPON', 'STATE', 'PARK'], null],
		["O'Neil Pond", ["O'NEIL"], null]
	])('%s', (raw, tokens, state) => {
		const q = parseWaterQuery(raw)!;
		expect(q.tokens).toEqual(tokens);
		expect(q.state).toBe(state);
	});
	it.each(['', '  ', 'ab', 'lake', 'Pond', 'x'.repeat(60), '%%%', ', MT'])('rejects %j', (raw) => expect(parseWaterQuery(raw)).toBeNull());
	it('ignores an unknown state suffix instead of filtering on it', () => expect(parseWaterQuery('Mud Lake, Narnia')!.state).toBeNull());
	it('strips wildcard and quote-breaking characters', () => {
		const q = parseWaterQuery("Mis%sou_ri\\ ';--")!;
		expect(q.tokens.join(' ')).not.toMatch(/[%_\;]/);
	});
});

describe('polygonCentroid', () => {
	it('finds the middle of a square', () => expect(polygonCentroid(square(-114, 47.9))).toMatchObject({ lat: expect.closeTo(47.9, 6), lng: expect.closeTo(-114, 6) }));
	it('uses the biggest ring (islands do not move it)', () => {
		const g = { rings: [...square(-114, 47.9, 0.5).rings, ...square(-113, 47, 0.01).rings] };
		expect(polygonCentroid(g)!.lng).toBeCloseTo(-114, 6);
	});
	it('returns null for nothing usable', () => { expect(polygonCentroid({})).toBeNull(); expect(polygonCentroid({ rings: [[[0, 0], [1, 1]]] })).toBeNull(); });
});

describe('searchWaterbodies', () => {
	it('returns named lakes with state and county from the point layer, and asks the polygon layer too', async () => {
		handler = (u) => u.host.startsWith('carto') ? { features: [gnis(1559164, 'Cacapon Lake', 'Reservoir', 'WV', 'Morgan', -78.306, 39.508)] } : { features: [] };
		const r = await searchWaterbodies('Cacapon Lake');
		expect(r.items).toEqual([{ siteId: 'GNIS-1559164', name: 'Cacapon Lake', kind: 'reservoir', state: 'West Virginia', county: 'Morgan', lat: 39.508, lng: -78.306, areaKm2: null }]);
		expect(hosts()).toEqual(['carto.nationalmap.gov', 'hydro.nationalmap.gov']);
		const where = calls[0].searchParams.get('where')!;
		expect(where).toContain("gaz_featureclass IN ('Lake','Reservoir')");
		expect(where).toContain("UPPER(gaz_name) LIKE '%CACAPON%'");
		expect(where).not.toContain('LAKE'); // the type word is not part of the match
	});

	it('adds big lakes that only the polygon layer has, with the state looked up from the centroid', async () => {
		handler = (u) => {
			if (u.host.startsWith('carto')) return { features: [] };
			if (u.host.startsWith('hydro')) return { features: [nhd('783514', 'Flathead Lake', 494.4, -114.18, 47.89)] };
			return { features: [{ attributes: { NAME: 'Montana' } }] };
		};
		const r = await searchWaterbodies('Flathead');
		expect(r.items).toHaveLength(1);
		expect(r.items[0]).toMatchObject({ siteId: 'GNIS-783514', name: 'Flathead Lake', state: 'Montana', areaKm2: 494.4, county: null });
		expect(r.items[0].lat).toBeCloseTo(47.89, 3);
	});

	it('does not repeat a lake both layers know, and keeps the biggest polygon of one with several', async () => {
		handler = (u) => {
			if (u.host.startsWith('carto')) return { features: [gnis(1, 'Lake Tahoe', 'Lake', 'CA', 'El Dorado', -120, 39)] };
			if (u.host.startsWith('hydro')) return { features: [nhd('1', 'Lake Tahoe', 5, -120, 39), nhd('2', 'Lake Two', 0.1, -100, 40), nhd('2', 'Lake Two', 3, -100.01, 40.01)] };
			return { features: [{ attributes: { NAME: 'Kansas' } }] };
		};
		const r = await searchWaterbodies('Tahoe Two'); // matches nothing real; only checking merge logic
		expect(r.items.map((i) => i.siteId).sort()).toEqual(['GNIS-1', 'GNIS-2']);
		expect(r.items.find((i) => i.siteId === 'GNIS-2')!.areaKm2).toBe(3);
	});

	it('skips the polygon layer and says "truncated" for a too-generic query', async () => {
		handler = (u) => ({ features: Array.from({ length: 100 }, (_, i) => gnis(i + 1, `Mud Lake ${i}`, 'Lake', 'MT', 'X', -110, 45)) });
		const r = await searchWaterbodies('Mud');
		expect(r.truncated).toBe(true);
		expect(hosts()).toEqual(['carto.nationalmap.gov']);
	});

	it('narrows to a state when asked ("Mud Lake, MT")', async () => {
		await searchWaterbodies('Mud Lake, MT');
		expect(calls[0].searchParams.get('where')).toContain("state_alpha='MT'");
	});

	it('doubles quotes so a name cannot break out of the filter', async () => {
		await searchWaterbodies("O'Neil Pond");
		expect(calls[0].searchParams.get('where')).toContain("'%O''NEIL%'");
	});

	it('ranks an exact name first, then names that start with it, then the rest; marks ponds', async () => {
		handler = (u) => u.host.startsWith('carto') ? { features: [
			gnis(3, 'Big Mud Lake', 'Lake', 'MT', 'A', -110, 45), gnis(2, 'Mud Lake Dam', 'Reservoir', 'MT', 'A', -110, 45),
			gnis(1, 'Mud Lake', 'Lake', 'MT', 'A', -110, 45), gnis(4, 'Mud Pond', 'Lake', 'MT', 'A', -110, 45)
		] } : { features: [] };
		const r = await searchWaterbodies('Mud Lake');
		expect(r.items.map((i) => i.name)).toEqual(['Mud Lake', 'Mud Lake Dam', 'Big Mud Lake', 'Mud Pond']);
		expect(r.items[3].kind).toBe('pond');
	});

	it('still answers from the point layer when the polygon layer is down', async () => {
		handler = (u) => u.host.startsWith('hydro') ? new Response('', { status: 500 }) : { features: [gnis(1, 'Cacapon Lake', 'Lake', 'WV', 'Morgan', -78.3, 39.5)] };
		expect((await searchWaterbodies('Cacapon')).items).toHaveLength(1);
	});

	it('throws when the point layer fails and nothing is cached; ArcGIS error bodies count as failures', async () => {
		handler = () => new Response('', { status: 503 });
		await expect(searchWaterbodies('Cacapon')).rejects.toBeInstanceOf(WaterbodyError);
		resetWaterbodyState();
		handler = () => ({ error: { code: 400, message: 'bad' } });
		await expect(searchWaterbodies('Cacapon')).rejects.toMatchObject({ detail: expect.stringContaining('400') });
	});

	it('caches searches', async () => {
		handler = () => ({ features: [] });
		await searchWaterbodies('Cacapon'); const n = calls.length;
		await searchWaterbodies('cacapon'); expect(calls.length).toBe(n);
	});

	it('returns nothing, without a request, for an unusable query', async () => {
		expect(await searchWaterbodies('lake')).toEqual({ items: [], truncated: false });
		expect(calls).toHaveLength(0);
	});
});

describe('getWaterbody', () => {
	it('looks a point-layer lake up by id', async () => {
		handler = () => ({ features: [gnis(1559164, 'Cacapon Lake', 'Reservoir', 'WV', 'Morgan', -78.306, 39.508)] });
		expect(await getWaterbody('GNIS-1559164')).toMatchObject({ name: 'Cacapon Lake', state: 'West Virginia', county: 'Morgan' });
		expect(calls[0].searchParams.get('where')).toBe("gaz_id=1559164 AND gaz_featureclass IN ('Lake','Reservoir')");
	});
	it('falls back to the polygon layer', async () => {
		handler = (u) => u.host.startsWith('carto') ? { features: [] } : u.host.startsWith('hydro') ? { features: [nhd('783514', 'Flathead Lake', 494, -114.18, 47.89)] } : { features: [{ attributes: { NAME: 'Montana' } }] };
		expect(await getWaterbody('GNIS-783514')).toMatchObject({ name: 'Flathead Lake', state: 'Montana' });
	});
	it.each(['USGS-06043500', 'GNIS-', 'GNIS-abc', "GNIS-1'; DROP", 'GNIS-12345678901'])('rejects %j without a request', async (id) => {
		expect(await getWaterbody(id)).toBeNull();
		expect(calls).toHaveLength(0);
	});
	it('returns null for an unknown id and throws on failure', async () => {
		expect(await getWaterbody('GNIS-999')).toBeNull();
		resetWaterbodyState();
		handler = () => new Response('', { status: 500 });
		await expect(getWaterbody('GNIS-999')).rejects.toBeInstanceOf(WaterbodyError);
	});
});
