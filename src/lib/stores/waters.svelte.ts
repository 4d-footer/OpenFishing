import type { GaugeView } from '#lib/server/waters.js';
import type { Weather } from '#lib/server/weather.js';

/** How long a client-side copy counts as fresh; the server has its own (5 min / 10 min) caches. */
const FRESH_MS = 60_000;

export const waters = $state({
	gauges: [] as GaugeView[],
	loaded: false,
	loading: false,
	stale: false,
	failed: false,
	fetchedAt: 0,
	weather: {} as Record<string, Weather | null>,
	weatherLoaded: false,
	weatherFetchedAt: 0
});

let inflight: Promise<void> | null = null;

/**
 * Fetch current readings + 24h series for every followed gauge. Called from the root layout on
 * each visit so the My Waters tab is already filled when opened. Safe to call repeatedly:
 * concurrent calls share one request and a fresh copy is reused unless `force` is set.
 */
export function loadWaters(force = false): Promise<void> {
	if (inflight) return inflight;
	if (!force && waters.loaded && Date.now() - waters.fetchedAt < FRESH_MS) return Promise.resolve();
	waters.loading = true;
	inflight = (async () => {
		try {
			const res = await fetch('/api/waters/data');
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { gauges: GaugeView[]; stale: boolean };
			waters.gauges = body.gauges;
			waters.stale = body.stale;
			waters.failed = false;
			waters.loaded = true;
			waters.fetchedAt = Date.now();
		} catch {
			waters.failed = true;
		} finally {
			waters.loading = false;
			inflight = null;
		}
	})();
	return inflight;
}

let weatherInflight: Promise<void> | null = null;
const WEATHER_FRESH_MS = 5 * 60_000;

/** Current conditions for every followed water (one request; the server caches 15 min). Failure leaves what we had. */
export function loadWeather(force = false): Promise<void> {
	if (weatherInflight) return weatherInflight;
	if (!force && waters.weatherLoaded && Date.now() - waters.weatherFetchedAt < WEATHER_FRESH_MS) return Promise.resolve();
	weatherInflight = (async () => {
		try {
			const res = await fetch('/api/waters/weather');
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { weather: Record<string, Weather | null> };
			waters.weather = body.weather;
			waters.weatherLoaded = true;
			waters.weatherFetchedAt = Date.now();
		} catch {
			/* weather is a bonus; tiles just omit it */
		} finally {
			weatherInflight = null;
		}
	})();
	return weatherInflight;
}

/** Use the server-rendered list (names only) until the first data fetch lands. */
export function seedWaters(gauges: GaugeView[]) {
	if (!waters.loaded) waters.gauges = gauges;
}

export function addWater(g: GaugeView) {
	waters.gauges = [...waters.gauges.filter((x) => x.siteId !== g.siteId), g];
	void loadWeather(true);
}

export function removeWater(id: string) {
	waters.gauges = waters.gauges.filter((g) => g.id !== id);
}

// ── Politeness for NOAA: tiles ask for their forecast at most two at a time ─────

let running = 0;
const waiting: (() => void)[] = [];
export async function queued<T>(fn: () => Promise<T>, max = 2): Promise<T> {
	if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
	running++;
	try {
		return await fn();
	} finally {
		running--;
		waiting.shift()?.();
	}
}
