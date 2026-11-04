import { describe, it, expect } from 'vitest';
import { parseAlerts, rulesFromJson, evaluate, condGroup, markerStatus, contextOf, COND_GROUPS, MARKER_COLOR } from '../alerts';

const ok = (x: unknown) => (parseAlerts(x) as any).rules;
const err = (x: unknown) => (parseAlerts(x) as any).error;

describe('parseAlerts', () => {
	it('accepts ranges, drops unknown keys, and returns null when nothing is set', () => {
		expect(ok({ flow: { min: 100, max: 500 }, junk: 1 })).toEqual({ flow: { min: 100, max: 500 } });
		expect(ok({ wind: { max: 15 } })).toEqual({ wind: { max: 15 } });
		expect(ok({ flow: {} })).toBeNull(); expect(ok({})).toBeNull(); expect(ok(null)).toBeNull(); expect(ok(undefined)).toBeNull();
		expect(ok({ airTemp: { min: null, max: 80 } })).toEqual({ airTemp: { max: 80 } });
	});
	it('rejects bad shapes, non-numbers, min above max, and absurd values', () => {
		expect(err('x')).toBe('invalid'); expect(err([])).toBe('invalid');
		expect(err({ flow: 5 })).toBe('invalid'); expect(err({ flow: { min: '5' } })).toBe('invalid');
		expect(err({ flow: { min: NaN } })).toBe('invalid'); expect(err({ flow: { max: 1e12 } })).toBe('invalid');
		expect(err({ flow: { min: 9, max: 1 } })).toBe('range');
		expect(ok({ flow: { min: 5, max: 5 } })).toEqual({ flow: { min: 5, max: 5 } });
		expect(ok({ stage: { min: -3 } })).toEqual({ stage: { min: -3 } });
	});
	it('checks conditions: known groups only; all or none ticked means any', () => {
		expect(ok({ conditions: ['clear', 'partly'] })).toEqual({ conditions: ['clear', 'partly'] });
		expect(ok({ conditions: ['partly', 'clear', 'clear'] })).toEqual({ conditions: ['clear', 'partly'] });
		expect(ok({ conditions: [] })).toBeNull(); expect(ok({ conditions: COND_GROUPS })).toBeNull();
		expect(err({ conditions: ['hail'] })).toBe('invalid'); expect(err({ conditions: 'clear' })).toBe('invalid');
	});
	it('reads stored JSON defensively', () => {
		expect(rulesFromJson('{"flow":{"min":1}}')).toEqual({ flow: { min: 1 } });
		expect(rulesFromJson('not json')).toBeNull(); expect(rulesFromJson(null)).toBeNull(); expect(rulesFromJson('{"flow":{"min":9,"max":1}}')).toBeNull();
	});
});

describe('condGroup', () => {
	it('groups WMO codes', () => {
		expect([0, 1, 2, 3, 45, 53, 63, 66, 81, 73, 86, 95].map(condGroup)).toEqual(['clear', 'clear', 'partly', 'cloudy', 'fog', 'rain', 'rain', 'rain', 'rain', 'snow', 'snow', 'storm']);
		expect(condGroup(null)).toBeNull(); expect(condGroup(1234)).toBeNull();
	});
});

describe('evaluate', () => {
	const w = (o: object = {}) => ({ tempF: 60, windMph: 5, code: 0, ...o });
	it('is "none" with no rules or nothing to check', () => {
		expect(evaluate(null, { flow: 100 }).status).toBe('none');
		expect(evaluate({ flow: { min: 50 } }, {}).status).toBe('none');
		expect(evaluate({ flow: { min: 50 } }, { flow: null }).status).toBe('none');
	});
	it('meets, and reports which limit is broken', () => {
		const r = { flow: { min: 100, max: 500 }, stage: { max: 3 } };
		expect(evaluate(r, { flow: 200, stage: 2 }).status).toBe('met');
		expect(evaluate(r, { flow: 200, stage: 3 }).status).toBe('met'); // limits are inclusive
		const low = evaluate(r, { flow: 88, stage: 2 });
		expect(low.status).toBe('unmet'); expect(low.problems).toEqual([{ key: 'flow', kind: 'below', value: 88, limit: 100 }]);
		expect(evaluate(r, { flow: 900, stage: 4 }).problems.map((p) => p.kind)).toEqual(['above', 'above']);
	});
	it('weather rules: temperature, wind, conditions', () => {
		const r = { airTemp: { min: 40, max: 85 }, wind: { max: 10 }, conditions: ['clear', 'partly'] as any };
		expect(evaluate(r, { weather: w() }).status).toBe('met');
		expect(evaluate(r, { weather: w({ tempF: 30 }) }).problems[0]).toMatchObject({ key: 'airTemp', kind: 'below' });
		expect(evaluate(r, { weather: w({ windMph: 22 }) }).problems[0]).toMatchObject({ key: 'wind', kind: 'above' });
		expect(evaluate(r, { weather: w({ code: 63 }) }).problems[0]).toMatchObject({ key: 'conditions', kind: 'condition' });
		expect(evaluate(r, { weather: null }).status).toBe('none');
	});
	it('skips a rule whose reading is missing but still judges the rest', () => {
		expect(evaluate({ flow: { min: 100 }, airTemp: { max: 50 } }, { weather: w({ tempF: 70 }) }).status).toBe('unmet');
		expect(evaluate({ flow: { min: 100 }, airTemp: { max: 90 } }, { weather: w() }).status).toBe('met');
	});
});

describe('contextOf + markerStatus', () => {
	const latest = { discharge: { value: 88, time: 't' }, stage: { value: 1.5, time: 't' }, extra: { '00010': { value: 13, time: 't' } } };
	it('reads flow, stage and water temperature (°C → °F) from the latest readings', () => {
		const c = contextOf(latest, null);
		expect(c.flow).toBe(88); expect(c.stage).toBe(1.5); expect(c.waterTemp).toBeCloseTo(55.4, 1);
		expect(contextOf(null, null)).toMatchObject({ flow: null, stage: null, waterTemp: null });
	});
	it('without criteria a gauge follows its trend: rising green, steady yellow, falling red', () => {
		expect(markerStatus(null, {}, 'rising')).toBe('good');
		expect(markerStatus(null, {}, 'steady')).toBe('steady');
		expect(markerStatus(null, {}, 'falling')).toBe('bad');
		expect(markerStatus(null, {}, null)).toBe('unknown');
	});
	it('criteria win over the trend', () => {
		const r = { flow: { min: 100, max: 500 } };
		expect(markerStatus(r, { flow: 88 }, 'rising')).toBe('bad');
		expect(markerStatus(r, { flow: 200 }, 'falling')).toBe('good');
		expect(markerStatus(r, {}, 'steady')).toBe('steady'); // nothing to check: back to the trend
	});
	it('a lake is judged by weather criteria, or stays neutral', () => {
		expect(markerStatus({ airTemp: { min: 50 } }, { weather: { tempF: 60, windMph: 1, code: 0 } }, null)).toBe('good');
		expect(markerStatus({ airTemp: { min: 50 } }, { weather: { tempF: 40, windMph: 1, code: 0 } }, null)).toBe('bad');
		expect(markerStatus(null, { weather: { tempF: 40, windMph: 1, code: 0 } }, null)).toBe('unknown');
		expect(MARKER_COLOR.good).toMatch(/^#/);
	});
});
