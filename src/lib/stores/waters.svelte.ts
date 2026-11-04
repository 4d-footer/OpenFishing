import type { GaugeView } from '#lib/server/waters.js';

/** How long a client-side copy counts as fresh; the server has its own (5 min / 10 min) caches. */
const FRESH_MS = 60_000;

export const waters = $state({
	gauges: [] as GaugeView[],
	loaded: false,
	loading: false,
	stale: false,
	failed: false,
	fetchedAt: 0
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

/** Use the server-rendered list (names only) until the first data fetch lands. */
export function seedWaters(gauges: GaugeView[]) {
	if (!waters.loaded) waters.gauges = gauges;
}

export function addWater(g: GaugeView) {
	waters.gauges = [...waters.gauges.filter((x) => x.siteId !== g.siteId), g];
}

export function removeWater(id: string) {
	waters.gauges = waters.gauges.filter((g) => g.id !== id);
}
