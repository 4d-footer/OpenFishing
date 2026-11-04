/**
 * Per-water alert criteria ("notify me when…") and what they say about a water right now. Pure and shared by the
 * server (validation) and the browser (tile status, map marker colour). Delivery of notifications is not built yet;
 * the criteria are stored and already drive the tile status and the map marker colour.
 */
import { METRICS, readingOf } from './geo.js';

export interface Range { min?: number; max?: number }
export type CondGroup = 'clear' | 'partly' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';
export const COND_GROUPS: CondGroup[] = ['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'storm'];
export const COND_LABEL = {
	clear: 'weatherClear', partly: 'weatherPartly', cloudy: 'weatherCloudy', fog: 'weatherFog',
	rain: 'weatherRain', snow: 'weatherSnow', storm: 'weatherThunder'
} as const;

export interface AlertRules {
	flow?: Range; // cfs
	stage?: Range; // ft
	waterTemp?: Range; // °F
	airTemp?: Range; // °F
	wind?: Range; // mph (only `max` is offered in the UI)
	conditions?: CondGroup[]; // acceptable weather; empty/absent = any
}

const RANGE_KEYS = ['flow', 'stage', 'waterTemp', 'airTemp', 'wind'] as const;
type RangeKey = (typeof RANGE_KEYS)[number];
const LIMIT = 1e9;

/** WMO weather code → the broad group people care about. */
export function condGroup(code: number | null | undefined): CondGroup | null {
	if (code === null || code === undefined) return null;
	if (code === 0 || code === 1) return 'clear';
	if (code === 2) return 'partly';
	if (code === 3) return 'cloudy';
	if (code === 45 || code === 48) return 'fog';
	if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
	if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
	if (code >= 95 && code <= 99) return 'storm';
	return null;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMIT ? v : undefined);

/**
 * Validate untrusted input. Returns the cleaned rules (null when nothing is set) or an error string. Unknown keys are
 * dropped; a min above its max is an error.
 */
export function parseAlerts(raw: unknown): { rules: AlertRules | null } | { error: string } {
	if (raw === null || raw === undefined) return { rules: null };
	if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid' };
	const src = raw as Record<string, unknown>;
	const out: AlertRules = {};
	for (const k of RANGE_KEYS) {
		const r = src[k];
		if (r === undefined || r === null) continue;
		if (typeof r !== 'object' || Array.isArray(r)) return { error: 'invalid' };
		const rr = r as Record<string, unknown>;
		for (const f of ['min', 'max'] as const) if (rr[f] !== undefined && rr[f] !== null && num(rr[f]) === undefined) return { error: 'invalid' };
		const min = num(rr.min), max = num(rr.max);
		if (min !== undefined && max !== undefined && min > max) return { error: 'range' };
		if (min !== undefined || max !== undefined) out[k] = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
	}
	if (src.conditions !== undefined && src.conditions !== null) {
		if (!Array.isArray(src.conditions)) return { error: 'invalid' };
		const set = new Set<CondGroup>();
		for (const c of src.conditions) {
			if (!COND_GROUPS.includes(c as CondGroup)) return { error: 'invalid' };
			set.add(c as CondGroup);
		}
		// Every group ticked is the same as none ticked.
		if (set.size && set.size < COND_GROUPS.length) out.conditions = COND_GROUPS.filter((g) => set.has(g));
	}
	return { rules: Object.keys(out).length ? out : null };
}

/** Parse what the database holds; anything unreadable counts as "no rules". */
export function rulesFromJson(json: string | null | undefined): AlertRules | null {
	if (!json) return null;
	try {
		const r = parseAlerts(JSON.parse(json));
		return 'rules' in r ? r.rules : null;
	} catch {
		return null;
	}
}

export interface AlertContext {
	flow?: number | null;
	stage?: number | null;
	waterTemp?: number | null;
	weather?: { tempF: number | null; windMph: number | null; code: number | null } | null;
}

export interface Problem { key: RangeKey | 'conditions'; kind: 'below' | 'above' | 'condition'; value: number | null; limit: number | null }
export interface Evaluation { status: 'met' | 'unmet' | 'none'; problems: Problem[] }

/** Compare current readings with the rules. A rule whose reading isn't available is skipped, not failed. */
export function evaluate(rules: AlertRules | null | undefined, ctx: AlertContext): Evaluation {
	if (!rules) return { status: 'none', problems: [] };
	const values: Record<RangeKey, number | null | undefined> = {
		flow: ctx.flow, stage: ctx.stage, waterTemp: ctx.waterTemp, airTemp: ctx.weather?.tempF, wind: ctx.weather?.windMph
	};
	const problems: Problem[] = [];
	let checked = 0;
	for (const k of RANGE_KEYS) {
		const r = rules[k], v = values[k];
		if (!r || v === null || v === undefined) continue;
		checked++;
		if (r.min !== undefined && v < r.min) problems.push({ key: k, kind: 'below', value: v, limit: r.min });
		else if (r.max !== undefined && v > r.max) problems.push({ key: k, kind: 'above', value: v, limit: r.max });
	}
	if (rules.conditions?.length) {
		const g = condGroup(ctx.weather?.code);
		if (g) {
			checked++;
			if (!rules.conditions.includes(g)) problems.push({ key: 'conditions', kind: 'condition', value: ctx.weather?.code ?? null, limit: null });
		}
	}
	if (!checked) return { status: 'none', problems: [] };
	return { status: problems.length ? 'unmet' : 'met', problems };
}

type LatestLike = Parameters<typeof readingOf>[0];

/** The readings a tile has, in the units the rules use. */
export function contextOf(latest: LatestLike, weather: AlertContext['weather']): AlertContext {
	return {
		flow: readingOf(latest, METRICS[0])?.value ?? null,
		stage: readingOf(latest, METRICS[1])?.value ?? null,
		waterTemp: readingOf(latest, METRICS[2])?.value ?? null, // already °F
		weather
	};
}

export type MarkerStatus = 'good' | 'steady' | 'bad' | 'unknown';
export const MARKER_COLOR: Record<MarkerStatus, string> = { good: '#22c55e', steady: '#eab308', bad: '#ef4444', unknown: 'var(--of-accent-solid)' };

/**
 * Map marker colour: the user's criteria win when they have any that can be checked (met = green, unmet = red).
 * Otherwise a gauge follows its trend (rising green, steady yellow, falling red); a lake with nothing to judge by
 * stays the neutral accent colour.
 */
export function markerStatus(rules: AlertRules | null | undefined, ctx: AlertContext, trend: 'rising' | 'falling' | 'steady' | null): MarkerStatus {
	const e = evaluate(rules, ctx);
	if (e.status === 'met') return 'good';
	if (e.status === 'unmet') return 'bad';
	return trend === 'rising' ? 'good' : trend === 'steady' ? 'steady' : trend === 'falling' ? 'bad' : 'unknown';
}
