import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { waterGauge } from '#lib/server/db/schema.js';
import { userFilter } from '#lib/server/scope.js';
import { parseAlerts } from '#lib/waters/alerts.js';

/** DELETE /api/waters/:id — stop following a gauge (only your own). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const where = and(eq(waterGauge.id, params.id), userFilter(locals, waterGauge.userId));
	const deleted = await db.delete(waterGauge).where(where).returning({ id: waterGauge.id });
	if (!deleted.length) return Response.json({ error: 'not_found' }, { status: 404 });
	return Response.json({ ok: true });
};

/** PATCH /api/waters/:id — `{alerts}`: set (or with null, clear) the "notify me when…" criteria for one of your waters. */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object' || !('alerts' in body)) return Response.json({ error: 'invalid' }, { status: 400 });
	const parsed = parseAlerts((body as { alerts: unknown }).alerts);
	if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
	const where = and(eq(waterGauge.id, params.id), userFilter(locals, waterGauge.userId));
	const updated = await db
		.update(waterGauge)
		.set({ alerts: parsed.rules ? JSON.stringify(parsed.rules) : null })
		.where(where)
		.returning({ id: waterGauge.id });
	if (!updated.length) return Response.json({ error: 'not_found' }, { status: 404 });
	return Response.json({ alerts: parsed.rules });
};
