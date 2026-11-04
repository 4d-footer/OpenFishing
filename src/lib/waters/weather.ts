/** Client-side helpers for showing weather: WMO code → icon + wording key, wind compass. No server imports. */

export type ConditionKey =
	| 'weatherClear' | 'weatherPartly' | 'weatherCloudy' | 'weatherFog' | 'weatherDrizzle' | 'weatherRain'
	| 'weatherSnow' | 'weatherShowers' | 'weatherSnowShowers' | 'weatherThunder' | 'weatherFreezingRain' | 'weatherUnknown';

export const CONDITION_KEYS: ConditionKey[] = [
	'weatherClear', 'weatherPartly', 'weatherCloudy', 'weatherFog', 'weatherDrizzle', 'weatherRain',
	'weatherSnow', 'weatherShowers', 'weatherSnowShowers', 'weatherThunder', 'weatherFreezingRain', 'weatherUnknown'
];

/** WMO weather interpretation code (Open-Meteo) → condition wording key and an emoji. */
export function condition(code: number | null | undefined, isDay: boolean | null | undefined = true): { key: ConditionKey; icon: string } {
	const day = isDay !== false;
	const c = code ?? -1;
	if (c === 0 || c === 1) return { key: 'weatherClear', icon: day ? '☀️' : '🌙' };
	if (c === 2) return { key: 'weatherPartly', icon: day ? '⛅' : '☁️' };
	if (c === 3) return { key: 'weatherCloudy', icon: '☁️' };
	if (c === 45 || c === 48) return { key: 'weatherFog', icon: '🌫️' };
	if (c >= 51 && c <= 55) return { key: 'weatherDrizzle', icon: '🌦️' };
	if (c === 56 || c === 57 || c === 66 || c === 67) return { key: 'weatherFreezingRain', icon: '🌧️' };
	if (c === 61 || c === 63 || c === 65) return { key: 'weatherRain', icon: '🌧️' };
	if (c === 71 || c === 73 || c === 75 || c === 77) return { key: 'weatherSnow', icon: '❄️' };
	if (c >= 80 && c <= 82) return { key: 'weatherShowers', icon: '🌦️' };
	if (c === 85 || c === 86) return { key: 'weatherSnowShowers', icon: '🌨️' };
	if (c >= 95 && c <= 99) return { key: 'weatherThunder', icon: '⛈️' };
	return { key: 'weatherUnknown', icon: '🌡️' };
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** 16-point compass name for a bearing in degrees (the direction the wind comes FROM). */
export function compass(deg: number | null | undefined): string {
	if (deg === null || deg === undefined || !Number.isFinite(deg)) return '';
	return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export const PRESSURE_ARROW = { rising: '↑', falling: '↓', steady: '→' } as const;
