import { describe, it, expect } from 'vitest';
import { bufferBounds, framingBounds, LOWER_48, thumbTiles, forecastWindows, horizonHours, clip, chartGeometry, nearestIndex, HOURS } from '../geo';

const miles = (a: number, b: number, lat: number) => ({
	ns: Math.abs(b - a) * 69.0,
	ewAt: (d: number) => d * 69.17 * Math.cos((lat * Math.PI) / 180)
});

describe('bufferBounds', () => {
	it('extends about 25 miles each way', () => {
		const [[s, w], [n, e]] = bufferBounds(45, -111);
		expect((n - s) * 69.0).toBeCloseTo(50, 0);
		expect((e - w) * 69.17 * Math.cos((45 * Math.PI) / 180)).toBeCloseTo(50, 0);
		expect((s + n) / 2).toBeCloseTo(45, 6);
		expect((w + e) / 2).toBeCloseTo(-111, 6);
	});
	it('widens in longitude toward the pole instead of exploding at it', () => {
		expect(bufferBounds(60, 0)[1][1]).toBeGreaterThan(bufferBounds(30, 0)[1][1]);
		expect(Number.isFinite(bufferBounds(89.9, 0)[1][1])).toBe(true);
	});
});

describe('framingBounds', () => {
	it('shows the lower 48 with no gauges (or none with a location)', () => {
		expect(framingBounds([])).toEqual(LOWER_48);
		expect(framingBounds([{ lat: null, lng: null }])).toEqual(LOWER_48);
	});
	it('frames a single gauge at its 25-mile box', () => {
		expect(framingBounds([{ lat: 45.3, lng: -111.2 }])).toEqual(bufferBounds(45.3, -111.2));
	});
	it('grows to contain every gauge (and its buffer) when more are added', () => {
		const a = { lat: 45.3, lng: -111.2 }, b = { lat: 38.6, lng: -91.5 };
		const [[s, w], [n, e]] = framingBounds([a, b]);
		for (const p of [a, b]) {
			expect(p.lat).toBeGreaterThan(s); expect(p.lat).toBeLessThan(n);
			expect(p.lng).toBeGreaterThan(w); expect(p.lng).toBeLessThan(e);
		}
		const one = framingBounds([a]);
		expect(n - s).toBeGreaterThan(one[1][0] - one[0][0]);
	});
	it('ignores gauges without a usable location', () => {
		expect(framingBounds([{ lat: 45.3, lng: -111.2 }, { lat: null, lng: 5 }, { lat: NaN, lng: 1 }])).toEqual(bufferBounds(45.3, -111.2));
	});
});

describe('thumbTiles', () => {
	it('covers the box and puts the point in its centre', () => {
		const size = 96, z = 12;
		const tiles = thumbTiles(45.2972, -111.2114, z, size);
		expect(tiles.length).toBeGreaterThanOrEqual(1);
		expect(tiles.length).toBeLessThanOrEqual(4);
		// every pixel of the box is covered by some tile
		for (const [px, py] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1], [size / 2, size / 2]]) {
			expect(tiles.some((t) => px >= t.left && px < t.left + 256 && py >= t.top && py < t.top + 256)).toBe(true);
		}
		expect(tiles[0].url).toMatch(/^https:\/\/basemap\.nationalmap\.gov\/.*\/tile\/12\/\d+\/\d+$/);
	});
	it('picks the right tile (zoom 0 is one tile; known coordinate at zoom 10)', () => {
		expect(thumbTiles(0, 0, 0, 100)[0].url.endsWith('/tile/0/0/0')).toBe(true);
		// Bozeman, MT at zoom 10 (x/y checked against an independent asinh formulation of slippy-map numbering)
		expect(thumbTiles(45.68, -111.04, 10, 10)[0].url.endsWith('/tile/10/365/196')).toBe(true);
	});
});

describe('forecastWindows', () => {
	it.each([
		[18, [null]],
		[30, [24]],
		[36, [24, null]],
		[50, [24, 48]],
		[168, [24, 48, 72, 168]],
		[240, [24, 48, 72, 168, null]],
		[0, [null]]
	])('horizon %i h', (h, want) => expect(forecastWindows(h)).toEqual(want));
});

describe('clip / horizon', () => {
	const now = 1_000_000_000_000;
	const pts = (from: number, to: number): [number, number][] => Array.from({ length: to - from + 1 }, (_, i) => [now + (from + i) * HOURS, i]);
	it('clips history to the window', () => {
		expect(clip(pts(-100, 0), 'past', 48, now)).toHaveLength(49);
		expect(clip(pts(-100, 0), 'past', null, now)).toHaveLength(101);
	});
	it('clips forecast ahead of now', () => {
		expect(clip(pts(-10, 100), 'future', 24, now).every((p) => p[0] <= now + 24 * HOURS && p[0] >= now - HOURS)).toBe(true);
		expect(clip(pts(-10, 100), 'future', null, now)).toHaveLength(102);
	});
	it('measures the horizon', () => {
		expect(horizonHours(pts(0, 18), now)).toBe(18);
		expect(horizonHours([], now)).toBe(0);
	});
});

describe('chartGeometry', () => {
	it('needs two points', () => expect(chartGeometry([[1, 1]])).toBeNull());
	it('scales into the box with the highest value on top', () => {
		const g = chartGeometry([[0, 10], [10, 20], [20, 15]], 300, 110)!;
		expect(g.min).toBe(10); expect(g.max).toBe(20);
		expect(g.xs).toEqual([0, 0.5, 1]);
		expect(g.ys[1]).toBeLessThan(g.ys[0]);
		expect(g.line.startsWith('M0.0,')).toBe(true);
		expect(g.area.endsWith('Z')).toBe(true);
	});
	it('handles a flat line without dividing by zero', () => {
		const g = chartGeometry([[0, 5], [1, 5]])!;
		expect(g.ys.every(Number.isFinite)).toBe(true);
	});
	it('finds the nearest point', () => expect(nearestIndex([0, 0.5, 1], 0.6)).toBe(1));
});

import { availableMetrics, readingOf, METRICS, cToF, formatValue, dualGeometry } from '../geo';

describe('metrics', () => {
	const latest = {
		discharge: { value: 87.8, time: 't' },
		stage: { value: 1.48, time: 't' },
		extra: { '00010': { value: 13.5, time: 't' }, '00400': { value: 8.1, time: 't' } }
	};
	it('converts water temperature to °F', () => {
		expect(cToF(0)).toBe(32);
		expect(cToF(13.5)).toBeCloseTo(56.3, 5);
		expect(readingOf(latest, METRICS.find((m) => m.key === 'temp')!)!.value).toBeCloseTo(56.3, 5);
	});
	it('lists only the readings a gauge has, in display order', () => {
		expect(availableMetrics(latest).map((m) => m.key)).toEqual(['discharge', 'stage', 'temp', 'ph']);
		expect(availableMetrics({ discharge: null, stage: { value: 1, time: 't' } }).map((m) => m.key)).toEqual(['stage']);
		expect(availableMetrics(null)).toEqual([]);
	});
	it('only flow and stage are forecastable', () => {
		expect(METRICS.filter((m) => m.forecastable).map((m) => m.key)).toEqual(['discharge', 'stage']);
	});
	it('formats with the metric precision', () => {
		expect(formatValue(1234.6, { decimals: 0 })).toBe((1235).toLocaleString());
		expect(formatValue(1.5, { decimals: 2 })).toBe('1.50');
	});
});

describe('dualGeometry', () => {
	const H = 3600_000, now = 1_000_000_000_000;
	const hist: [number, number][] = [[now - 48 * H, 10], [now - 24 * H, 20], [now, 15]];
	const fc: [number, number][] = [[now + 12 * H, 18], [now + 24 * H, 30]];
	it('puts history then forecast on one axis with "now" between them', () => {
		const g = dualGeometry(hist, fc)!;
		expect(g.t0).toBe(now - 48 * H); expect(g.t1).toBe(now + 24 * H);
		expect(g.nowX).toBeCloseTo(48 / 72, 6);
		expect(g.max).toBe(30);
		expect(g.points.map((p) => p.forecast)).toEqual([false, false, false, true, true]);
		expect(g.fcLine.startsWith('M')).toBe(true);
		expect(g.fcLine.split('L').length).toBe(3); // seam point + 2 forecast points
	});
	it('draws history alone, or forecast alone, without a "now" marker', () => {
		const h = dualGeometry(hist, [])!;
		expect(h.nowX).toBeNull(); expect(h.fcLine).toBe('');
		const f = dualGeometry([], fc)!;
		expect(f.nowX).toBeNull(); expect(f.histLine).toBe(''); expect(f.fcLine).not.toBe('');
	});
	it('drops forecast points that overlap the history', () => {
		const g = dualGeometry(hist, [[now - 1 * H, 99], ...fc])!;
		expect(g.points.filter((p) => p.forecast)).toHaveLength(2);
		expect(g.max).toBe(30);
	});
	it('needs at least two points in total, and survives a flat series', () => {
		expect(dualGeometry([[1, 1]], [])).toBeNull();
		expect(dualGeometry([[1, 5], [2, 5]], [])!.points.every((p) => Number.isFinite(p.y))).toBe(true);
	});
});
