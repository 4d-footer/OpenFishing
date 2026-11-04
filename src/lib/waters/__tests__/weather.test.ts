import { describe, it, expect } from 'vitest';
import { compass, condition, CONDITION_KEYS } from '../weather';
import { splitHourly } from '../geo';
import en from '../../i18n/en';

describe('weather helpers', () => {
	it('names the 16 compass points and survives bad input', () => {
		expect(compass(0)).toBe('N'); expect(compass(90)).toBe('E'); expect(compass(225)).toBe('SW');
		expect(compass(359)).toBe('N'); expect(compass(-90)).toBe('W');
		expect(compass(null)).toBe(''); expect(compass(NaN)).toBe('');
	});
	it('maps WMO codes to a condition, with a moon for clear nights', () => {
		expect(condition(0, true)).toEqual({ key: 'weatherClear', icon: '☀️' });
		expect(condition(0, false).icon).toBe('🌙');
		expect(condition(95).key).toBe('weatherThunder');
		expect(condition(61).key).toBe('weatherRain');
		expect(condition(73).key).toBe('weatherSnow');
		expect(condition(66).key).toBe('weatherFreezingRain');
		expect(condition(null).key).toBe('weatherUnknown');
		expect(condition(1234).key).toBe('weatherUnknown');
	});
	it('every condition key has wording', () => {
		for (const k of CONDITION_KEYS) expect((en as any)[k]).toBeTruthy();
	});
	it('splits hourly data into past and future around now', () => {
		const h = { t: [1, 2, 3, 4], tempF: [10, 11, NaN, 13] } as any;
		const s = splitHourly(h, 'tempF', 2);
		expect(s.past).toEqual([[1, 10], [2, 11]]);
		expect(s.future).toEqual([[4, 13]]);
		expect(splitHourly(h, 'nope', 2)).toEqual({ past: [], future: [] });
	});
});
