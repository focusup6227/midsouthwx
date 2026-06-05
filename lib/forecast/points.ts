// Point-forecast helpers for the /forecast/data meteogram panel.
//
// The NWS gridpoint forecast is the canonical hourly public forecast (NDFD-
// derived). We resolve a lat/lon → office gridpoint → hourly series in a
// route handler (see app/api/forecast/point/route.ts) and render it as a
// dependency-free SVG meteogram client-side.

export type ForecastPoint = {
  key: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
};

// Mid-South AOR anchor cities. Mirrors the spirit of the RAOB station list in
// soundings.ts — quick presets for the home region, with a free lat/lon entry
// for anywhere else. Memphis (home WFO MEG) is the default.
export const MIDSOUTH_POINTS: ForecastPoint[] = [
  { key: 'mem', city: 'Memphis',      state: 'TN', lat: 35.15, lon: -90.05 },
  { key: 'bna', city: 'Nashville',    state: 'TN', lat: 36.17, lon: -86.78 },
  { key: 'jan', city: 'Jackson',      state: 'MS', lat: 32.30, lon: -90.18 },
  { key: 'lit', city: 'Little Rock',  state: 'AR', lat: 34.74, lon: -92.29 },
  { key: 'jbr', city: 'Jonesboro',    state: 'AR', lat: 35.84, lon: -90.70 },
  { key: 'tup', city: 'Tupelo',       state: 'MS', lat: 34.26, lon: -88.70 },
  { key: 'hsv', city: 'Huntsville',   state: 'AL', lat: 34.73, lon: -86.59 },
  { key: 'mkl', city: 'Jackson',      state: 'TN', lat: 35.61, lon: -88.81 },
];

export const DEFAULT_POINT = MIDSOUTH_POINTS[0];

export function cToF(c: number | null | undefined): number | null {
  if (c == null || Number.isNaN(c)) return null;
  return c * 9 / 5 + 32;
}

// NWS hourly forecast gives wind direction as a cardinal string ("SSW").
// Convert to compass degrees so the meteogram can draw a rotated arrow.
const CARDINAL_DEG: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

export function cardinalToDeg(card: string | null | undefined): number | null {
  if (!card) return null;
  return CARDINAL_DEG[card.toUpperCase()] ?? null;
}

// "10 mph" / "5 to 10 mph" → take the upper bound integer.
export function parseWindMph(s: string | null | undefined): number | null {
  if (!s) return null;
  const nums = s.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  return Math.max(...nums.map(Number));
}

export type HourPoint = {
  time: string;        // ISO start time
  tempF: number | null;
  dewpF: number | null;
  rh: number | null;   // percent
  pop: number | null;  // percent
  windDeg: number | null;
  windMph: number | null;
  short: string;
};

export type PointForecast = {
  location: {
    city: string | null;
    state: string | null;
    office: string | null;
    radarStation: string | null;
    timeZone: string | null;
    lat: number;
    lon: number;
  };
  updated: string | null;
  hourly: HourPoint[];
  obs: {
    station: string | null;
    time: string | null;
    tempF: number | null;
    dewpF: number | null;
    windDeg: number | null;
    windKt: number | null;
    gustKt: number | null;
    wx: string | null;
    raw: string | null;
  } | null;
  error?: string;
};
