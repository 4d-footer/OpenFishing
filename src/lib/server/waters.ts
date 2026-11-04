import { asc } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { waterGauge } from '#lib/server/db/schema.js';
import { userFilter } from '#lib/server/scope.js';
import {
	getLatest,
	getSeries,
	peekLatest,
	peekSeries,
	trendOf,
	type Latest,
	type Series,
	type Trend
} from '#lib/server/usgs.js';

/** Most gauges one user can follow — keeps the batched USGS requests small. */
export const MAX_GAUGES = 24;

export type GaugeRow = typeof waterGauge.$inferSelect;

export interface GaugeView {
	id: string;
	siteId: string;
	number: string;
	name: string;
	river: string | null;
	state: string | null;
	lat: number | null;
	lng: number | null;
	usgsUrl: string;
	latest: Latest | null;
	series: { param: string; points: [number, number][] } | null;
	trend: Trend | null;
}

export async function listGauges(locals: App.Locals): Promise<GaugeRow[]> {
	return db
		.select()
		.from(waterGauge)
		.where(userFilter(locals, waterGauge.userId))
		.orderBy(asc(waterGauge.sortOrder), asc(waterGauge.createdAt));
}

export function toView(row: GaugeRow, latest: Latest | null = null, series: Series | null = null): GaugeView {
	const number = row.siteId.replace(/^USGS-/, '');
	return {
		id: row.id,
		siteId: row.siteId,
		number,
		name: row.name,
		river: row.river,
		state: row.state,
		lat: row.lat,
		lng: row.lng,
		usgsUrl: `https://waterdata.usgs.gov/monitoring-location/${number}/`,
		latest,
		series,
		trend: trendOf(series)
	};
}

/** Saved gauges with live data. Waits for USGS (cached 5-10 min); never throws on USGS trouble. */
export async function loadGaugeViews(rows: GaugeRow[]): Promise<{ gauges: GaugeView[]; stale: boolean }> {
	const ids = rows.map((r) => r.siteId);
	if (!ids.length) return { gauges: [], stale: false };
	const [latest, series] = await Promise.all([getLatest(ids), getSeries(ids)]);
	return {
		gauges: rows.map((r) => toView(r, latest.data.get(r.siteId) ?? null, series.data.get(r.siteId) ?? null)),
		stale: latest.stale || series.stale
	};
}

/** Saved gauges with whatever is cached right now. No network: safe for page loads. */
export function peekGaugeViews(rows: GaugeRow[]): GaugeView[] {
	const ids = rows.map((r) => r.siteId);
	const latest = peekLatest(ids);
	const series = peekSeries(ids);
	return rows.map((r) => toView(r, latest.get(r.siteId) ?? null, series.get(r.siteId) ?? null));
}

// ── Search throttle: each uncached search costs USGS requests, so cap it per user ───

const SEARCH_WINDOW_MS = 60_000;
const SEARCH_MAX = 20;
const searchHits = new Map<string, number[]>();

export function searchAllowed(key: string, now = Date.now()): boolean {
	const recent = (searchHits.get(key) ?? []).filter((t) => now - t < SEARCH_WINDOW_MS);
	if (recent.length >= SEARCH_MAX) {
		searchHits.set(key, recent);
		return false;
	}
	recent.push(now);
	searchHits.set(key, recent);
	return true;
}
export function resetSearchThrottle() {
	searchHits.clear();
}
