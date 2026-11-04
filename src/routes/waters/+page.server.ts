import type { PageServerLoad } from './$types';
import { MAX_GAUGES, listGauges, peekGaugeViews } from '#lib/server/waters.js';

export const load: PageServerLoad = async ({ locals }) => {
	const rows = await listGauges(locals);
	// Instant render: whatever the preload already put in the server cache (no network here).
	return { gauges: peekGaugeViews(rows), max: MAX_GAUGES };
};
