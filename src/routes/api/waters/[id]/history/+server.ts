import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { waterGauge } from '#lib/server/db/schema.js';
import { userFilter } from '#lib/server/scope.js';
import { getRangeSeries, HISTORY_HOURS, SERIES_PARAMS, UsgsError } from '#lib/server/usgs.js';

/** GET /api/waters/:id/history?hours=24|48|72|168[&param=00060|00065|00010|...] — readings for one of your gauges. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const hours = Number(url.searchParams.get('hours'));
	if (!(HISTORY_HOURS as readonly number[]).includes(hours)) return Response.json({ error: 'invalid' }, { status: 400 });
	const param = url.searchParams.get('param') ?? undefined;
	if (param !== undefined && !SERIES_PARAMS.includes(param)) return Response.json({ error: 'invalid' }, { status: 400 });
	const [row] = await db
		.select({ siteId: waterGauge.siteId })
		.from(waterGauge)
		.where(and(eq(waterGauge.id, params.id), userFilter(locals, waterGauge.userId)));
	if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
	try {
		const { series, stale } = await getRangeSeries(row.siteId, hours, param);
		return Response.json({ hours, param: param ?? null, series, stale }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (e) {
		if (e instanceof UsgsError) return Response.json({ error: e.code }, { status: e.code === 'rate_limited' ? 429 : 503 });
		throw e;
	}
};
