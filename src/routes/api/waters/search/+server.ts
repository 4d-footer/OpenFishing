import type { RequestHandler } from './$types';
import { searchGauges, parseQuery, UsgsError } from '#lib/server/usgs.js';
import { listGauges, searchAllowed } from '#lib/server/waters.js';

/** GET /api/waters/search?q=missouri river — active USGS stream gauges on that river. */
export const GET: RequestHandler = async ({ url, locals }) => {
	const q = url.searchParams.get('q') ?? '';
	if (!parseQuery(q)) return Response.json({ error: 'invalid' }, { status: 400 });
	if (!searchAllowed(locals?.user?.id ?? 'open')) return Response.json({ error: 'too_many' }, { status: 429 });

	try {
		const [found, saved] = await Promise.all([searchGauges(q), listGauges(locals)]);
		const have = new Set(saved.map((s) => s.siteId));
		return Response.json({
			gauges: found.gauges.map((g) => ({ ...g, saved: have.has(g.siteId) })),
			truncated: found.truncated,
			stale: found.stale
		});
	} catch (e) {
		if (e instanceof UsgsError) {
			return Response.json({ error: e.code }, { status: e.code === 'rate_limited' ? 429 : 503 });
		}
		throw e;
	}
};
