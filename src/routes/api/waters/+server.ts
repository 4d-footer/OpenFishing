import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { waterGauge } from '#lib/server/db/schema.js';
import { ownerId, userFilter } from '#lib/server/scope.js';
import { getSite, UsgsError } from '#lib/server/usgs.js';
import { MAX_GAUGES, listGauges, toView } from '#lib/server/waters.js';

/** POST /api/waters  { siteId }  — follow a gauge. Name and location come from USGS, not the client. */
export const POST: RequestHandler = async ({ request, locals }) => {
	let body: any;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'invalid' }, { status: 400 });
	}
	const siteId = typeof body?.siteId === 'string' ? body.siteId.trim() : '';
	if (!/^USGS-\d{8,15}$/.test(siteId)) return Response.json({ error: 'invalid' }, { status: 400 });

	const mine = await listGauges(locals);
	if (mine.some((g) => g.siteId === siteId)) return Response.json({ error: 'duplicate' }, { status: 409 });
	if (mine.length >= MAX_GAUGES) return Response.json({ error: 'limit', max: MAX_GAUGES }, { status: 422 });

	let site;
	try {
		site = await getSite(siteId);
	} catch (e) {
		if (e instanceof UsgsError) return Response.json({ error: e.code }, { status: e.code === 'rate_limited' ? 429 : 503 });
		throw e;
	}
	if (!site) return Response.json({ error: 'not_found' }, { status: 404 });

	const [next] = await db
		.select({ n: sql<number>`coalesce(max(${waterGauge.sortOrder}), -1) + 1` })
		.from(waterGauge)
		.where(userFilter(locals, waterGauge.userId));
	const [row] = await db
		.insert(waterGauge)
		.values({
			userId: ownerId(locals),
			siteId: site.siteId,
			name: site.name,
			river: site.river,
			state: site.state,
			lat: site.lat,
			lng: site.lng,
			sortOrder: next?.n ?? 0
		})
		.returning();
	return Response.json({ gauge: toView(row) }, { status: 201 });
};
