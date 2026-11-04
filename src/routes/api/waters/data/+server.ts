import type { RequestHandler } from './$types';
import { listGauges, loadGaugeViews } from '#lib/server/waters.js';

/**
 * GET /api/waters/data — the user's saved gauges with current readings and a 24h series.
 * The app calls this in the background on every visit (it warms the shared server cache) and
 * the My Waters page reads it too, so opening the tab is instant.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const rows = await listGauges(locals);
	const { gauges, stale } = await loadGaugeViews(rows);
	return Response.json(
		{ gauges, stale, fetchedAt: Date.now() },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
