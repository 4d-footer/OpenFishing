import type { RequestHandler } from './$types';
import { listGauges } from '#lib/server/waters.js';
import { getWeather } from '#lib/server/weather.js';

/** GET /api/waters/weather — current conditions and a 48 h strip for each followed water (one Open-Meteo call). */
export const GET: RequestHandler = async ({ locals }) => {
	const rows = await listGauges(locals);
	const { data, stale } = await getWeather(rows.map((r) => ({ id: r.id, lat: r.lat, lng: r.lng })));
	return Response.json(
		{ weather: Object.fromEntries(data), stale, fetchedAt: Date.now() },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
