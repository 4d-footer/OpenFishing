import type { RequestHandler } from './$types';
import { searchGauges, parseQuery, UsgsError } from '#lib/server/usgs.js';
import { searchWaterbodies, parseWaterQuery } from '#lib/server/waterbodies.js';
import { listGauges, searchAllowed } from '#lib/server/waters.js';

const LAKE_WORDS = /\b(lakes?|ponds?|reservoir|lagoon)\b/i;
const RIVER_WORDS = /\b(rivers?|r|creeks?|cr|forks?|branch|brook|run|bayou|stream)\b/i;

/**
 * GET /api/waters/search?q=…  — active USGS stream gauges on a river AND named lakes/reservoirs/ponds.
 * "Mud Lake" searches lakes only, "Gallatin River" gauges only, "Cacapon" both.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const q = url.searchParams.get('q') ?? '';
	const riverQ = parseQuery(q);
	const lakeQ = parseWaterQuery(q);
	if (!riverQ && !lakeQ) return Response.json({ error: 'invalid' }, { status: 400 });
	if (!searchAllowed(locals?.user?.id ?? 'open')) return Response.json({ error: 'too_many' }, { status: 429 });

	const wantGauges = !!riverQ && !LAKE_WORDS.test(q);
	const wantLakes = !!lakeQ && !RIVER_WORDS.test(q);

	const [g, w, saved] = await Promise.all([
		wantGauges ? searchGauges(q).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })) : null,
		wantLakes ? searchWaterbodies(q).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })) : null,
		listGauges(locals)
	]);

	// Both halves failed: report USGS' trouble (rate limit / unavailable); a lone failure still returns the other half.
	const failures = [g, w].filter((x) => x && !x.ok) as { ok: false; e: unknown }[];
	const answered = [g, w].filter((x) => x && x.ok).length;
	if (failures.length && !answered) {
		const usgs = failures.map((f) => f.e).find((e) => e instanceof UsgsError) as UsgsError | undefined;
		if (usgs) return Response.json({ error: usgs.code }, { status: usgs.code === 'rate_limited' ? 429 : 503 });
		return Response.json({ error: 'unavailable' }, { status: 503 });
	}

	const have = new Set(saved.map((s) => s.siteId));
	return Response.json({
		gauges: g?.ok ? g.v.gauges.map((x) => ({ ...x, saved: have.has(x.siteId) })) : [],
		truncated: g?.ok ? g.v.truncated : false,
		stale: g?.ok ? g.v.stale : false,
		waterbodies: w?.ok ? w.v.items.map((x) => ({ ...x, saved: have.has(x.siteId) })) : [],
		waterbodiesTruncated: w?.ok ? w.v.truncated : false,
		partial: failures.length ? (g && !g.ok ? 'gauges' : 'lakes') : null
	});
};
