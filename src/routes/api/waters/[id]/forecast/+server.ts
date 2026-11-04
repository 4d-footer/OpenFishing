import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { waterGauge } from '#lib/server/db/schema.js';
import { userFilter } from '#lib/server/scope.js';
import { getForecast, ForecastError } from '#lib/server/forecast.js';

/** GET /api/waters/:id/forecast — NWS river forecast or National Water Model flow for one of your gauges. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const [row] = await db
		.select({ siteId: waterGauge.siteId, lat: waterGauge.lat, lng: waterGauge.lng })
		.from(waterGauge)
		.where(and(eq(waterGauge.id, params.id), userFilter(locals, waterGauge.userId)));
	if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
	try {
		const { forecast, stale } = await getForecast(row.siteId, row.lat, row.lng);
		return Response.json({ forecast, stale }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (e) {
		if (e instanceof ForecastError) return Response.json({ error: 'unavailable' }, { status: 503 });
		throw e;
	}
};
