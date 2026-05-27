// Per-subscriber time-to-impact computation for convective NWS warnings.
//
// Parses the storm position + motion from `raw.properties.parameters` on the
// NWS alert (same format the dashboard's lib/nws/storm-tracks.ts handles) and
// projects the storm forward along its motion vector. For each subscriber
// point we compute closest-approach time + miss distance and render a short
// prefix the worker prepends to the message body.
//
// Kept in this folder (not _shared/) because only the send worker consumes it.

export type StormMotion = {
  lon: number;
  lat: number;
  deg: number;   // bearing storm is moving TOWARD (true)
  kts: number;
};

export type ImpactResult = {
  minutes: number;
  missKm: number;
  bearingFromSub: string;  // compass direction from subscriber to storm
};

const COMPASS_16 = [
  'N', 'NNE', 'NE', 'ENE',
  'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW',
  'W', 'WNW', 'NW', 'NNW',
];

const EMD_HEAD_RE =
  /(\d+(?:\.\d+)?)\s*DEG\s*\.\.\.\s*(\d+(?:\.\d+)?)\s*KT\s*\.\.\.\s*([-\d.,\s]+)/i;

/**
 * Parse parameters.eventMotionDescription. Format:
 *   "<ISO>...storm...<deg>DEG...<kts>KT...<lat1>,<lon1>[ <lat2>,<lon2> ...]"
 * NWS direction is the bearing the storm is moving FROM, so we flip 180° to
 * match the rest of the pipeline.
 */
export function parseEventMotion(input: unknown): StormMotion | null {
  const text = Array.isArray(input)
    ? String(input[0] ?? '')
    : typeof input === 'string'
      ? input
      : '';
  if (!text) return null;

  const m = text.match(EMD_HEAD_RE);
  if (!m) return null;
  const fromDeg = parseFloat(m[1]);
  const kts = parseFloat(m[2]);
  if (!Number.isFinite(fromDeg) || !Number.isFinite(kts)) return null;

  // First lat,lon pair = current position (NWS lists most-recent first).
  const pair = m[3].match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!pair) return null;
  const lat = parseFloat(pair[1]);
  const lon = parseFloat(pair[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return { lon, lat, deg: (fromDeg + 180) % 360, kts };
}

/**
 * Project the storm forward along its motion vector and compute the closest-
 * approach time + perpendicular miss distance to the subscriber. Returns null
 * when the storm has already passed the subscriber (along-track t <= 0) or
 * when speed is zero/missing.
 *
 * Uses a flat local projection — accurate to within a few % over the
 * <100 km / <90 min window we actually care about for impact prefixes.
 */
export function timeToImpact(
  storm: StormMotion,
  sub: { lon: number; lat: number },
): ImpactResult | null {
  if (storm.kts <= 0) return null;

  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((storm.lat * Math.PI) / 180);

  // Subscriber relative to storm origin, in km.
  const px = (sub.lon - storm.lon) * kmPerDegLon;
  const py = (sub.lat - storm.lat) * kmPerDegLat;

  // Motion unit vector (compass bearing → east/north components).
  const rad = (storm.deg * Math.PI) / 180;
  const mx = Math.sin(rad);
  const my = Math.cos(rad);

  // Along-track distance from storm to closest-approach point (km).
  const t = px * mx + py * my;
  if (t <= 0) return null;

  // Perpendicular miss distance (km).
  const closestX = t * mx;
  const closestY = t * my;
  const missKm = Math.hypot(px - closestX, py - closestY);

  const speedKmPerMin = (storm.kts * 1.852) / 60;
  const minutes = t / speedKmPerMin;

  // Compass bearing FROM subscriber TO storm (what direction to look).
  const bearingDeg = (Math.atan2(-px, -py) * 180) / Math.PI;
  const bearingPos = (bearingDeg + 360) % 360;
  const bearing = COMPASS_16[Math.round(bearingPos / 22.5) % 16];

  return { minutes, missKm, bearingFromSub: bearing };
}

/** Heuristic: convective warnings benefit from a per-subscriber impact prefix. */
export function isConvectiveWarning(event: string | null | undefined): boolean {
  if (!event) return false;
  const e = event.toLowerCase();
  if (!e.includes('warning') && !e.includes('emergency') && !e.includes('special marine')) {
    return false;
  }
  return (
    e.includes('tornado') ||
    e.includes('severe thunderstorm') ||
    e.includes('flash flood') ||
    e.includes('special marine')
  );
}

/**
 * Render a one-line prefix to prepend to the message body. Returns null when
 * the storm is too far off / too far out to be worth interrupting the lead
 * line with — we'd rather under-prefix than cry wolf.
 */
export function formatImpactPrefix(impact: ImpactResult): string | null {
  // Miss > ~10 mi: storm isn't really tracking toward this subscriber.
  if (impact.missKm > 16) return null;
  // > 90 min out: low-confidence projection, skip.
  if (impact.minutes > 90 || impact.minutes < 0) return null;

  const min = Math.max(1, Math.round(impact.minutes));
  const missMi = Math.max(0, Math.round(impact.missKm / 1.609));
  const bearing = impact.bearingFromSub;

  if (min <= 5) {
    return `⚠️ IMMINENT — storm to your ${bearing}, ~${min} min away\n\n`;
  }
  if (min <= 20) {
    return `⏱ Closest approach ~${min} min (${missMi} mi ${bearing} of you)\n\n`;
  }
  return `⏱ Storm projected ~${min} min away (${missMi} mi ${bearing})\n\n`;
}
