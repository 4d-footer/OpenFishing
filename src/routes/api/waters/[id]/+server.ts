import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { waterGauge } from '#lib/server/db/schema.js';
import { userFilter } from '#lib/server/scope.js';

/** DELETE /api/waters/:id — stop following a gauge (only your own). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const where = and(eq(waterGauge.id, params.id), userFilter(locals, waterGauge.userId));
	const deleted = await db.delete(waterGauge).where(where).returning({ id: waterGauge.id });
	if (!deleted.length) return Response.json({ error: 'not_found' }, { status: 404 });
	return Response.json({ ok: true });
};
