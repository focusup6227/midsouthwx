import { classifyNwsEvent, type NwsHazardKind } from '@/lib/nws/radar';

/** NWS CAP parameters.stormLocation / stormMotion (convective warnings). */

const KTS_TO_KM_PER_MIN = 1.852 / 60;

function paramStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

/** Parse "lat,lon HHMM" or "lat,lon" → [lon, lat] for GeoJSON. */
export function parseStormLocationPoints(values: unknown): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of paramStrings(values)) {
    const m = raw.match(/^([-\d.]+)\s*,\s*([-\d.]+)/);
    if (!m) continue;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push([lon, lat]);
  }
  return out;
}

/** Parse "direction,speed" (degrees, knots) — direction storm is moving toward. */
export function parseStormMotion(values: unknown): { deg: number; kts: number } | null {
  const raw = paramStrings(values)[0];
  if (!raw) return null;
  const parts = raw.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { deg: parts[0], kts: parts[1] };
}

/**
 * Parse the modern NWS eventMotionDescription. Replaces the old
 * stormLocation + stormMotion CAP parameters (which NWS no longer ships on
 * SVR/TOR/etc.). Format observed in the wild:
 *   "<ISO timestamp>...storm...<deg>DEG...<kts>KT...<lat1>,<lon1>[ <lat2>,<lon2> ...]"
 * e.g.
 *   "2026-05-24T03:01:00-00:00...storm...209DEG...8KT...33.35,-100.9"
 *   "2026-05-24T03:11:00-00:00...storm...297DEG...26KT...33.93,-101.36 33.65,-101.53 33.33,-101.81"
 *
 * When multiple lat,lon pairs are present, the FIRST is the current location
 * and subsequent pairs are PAST observations (most-recent-first). We return
 * `observed` ordered past→present so the existing observed-LineString logic
 * draws a smooth trail with the projected forecast continuing forward.
 *
 * Direction in eventMotionDescription is meteorological — the bearing the
 * storm is moving *FROM* (e.g. "209DEG" = moving FROM south-southwest, i.e.
 * TOWARD north-northeast). We flip it by 180° at parse time so the rest of
 * the pipeline (projectPoint, arrowhead rotation) gets a consistent "TOWARD"
 * bearing, matching parseStormMotion's documented convention.
 */
const EMD_HEAD_RE =
  /(\d+(?:\.\d+)?)\s*DEG\s*\.\.\.\s*(\d+(?:\.\d+)?)\s*KT\s*\.\.\.\s*([-\d.,\s]+)/i;
const EMD_PAIR_RE = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g;
export function parseEventMotionDescription(
  values: unknown,
): { motion: { deg: number; kts: number }; observed: [number, number][] } | null {
  for (const raw of paramStrings(values)) {
    const m = raw.match(EMD_HEAD_RE);
    if (!m) continue;
    const fromDeg = parseFloat(m[1]);
    const kts = parseFloat(m[2]);
    if (!Number.isFinite(fromDeg) || !Number.isFinite(kts)) continue;
    const deg = (fromDeg + 180) % 360;

    const points: [number, number][] = [];
    for (const pair of m[3].matchAll(EMD_PAIR_RE)) {
      const lat = parseFloat(pair[1]);
      const lon = parseFloat(pair[2]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) points.push([lon, lat]);
    }
    if (points.length === 0) continue;
    // NWS lists current location first; flip so observed array is past→present.
    points.reverse();
    return { motion: { deg, kts }, observed: points };
  }
  return null;
}

function projectPoint(
  lon: number,
  lat: number,
  directionDeg: number,
  distanceKm: number,
): [number, number] {
  const rad = (directionDeg * Math.PI) / 180;
  const dLat = (distanceKm / 111.32) * Math.cos(rad);
  const dLon = (distanceKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(rad);
  return [lon + dLon, lat + dLat];
}

export type StormTrackInput = {
  id: string;
  event: string;
  raw: unknown;
};

type StormTrackGeometry = GeoJSON.LineString | GeoJSON.Point;

export function stormTracksFromAlert(
  alert: StormTrackInput,
  opts: { forecastMinutes?: number } = {},
): GeoJSON.Feature<StormTrackGeometry>[] {
  const forecastMinutes = opts.forecastMinutes ?? 60;
  const e = alert.event.toLowerCase();
  if (
    !e.includes('warning') &&
    !e.includes('emergency') &&
    !e.includes('special marine')
  ) {
    return [];
  }

  const raw = alert.raw as { properties?: { parameters?: Record<string, unknown> } } | null;
  const params = raw?.properties?.parameters;
  if (!params) return [];

  // Prefer the legacy stormLocation/stormMotion fields when present; fall back
  // to the modern packed eventMotionDescription, which is what api.weather.gov
  // actually ships on current SVR/TOR/etc. warnings.
  let observed = parseStormLocationPoints(params.stormLocation);
  let motion = parseStormMotion(params.stormMotion);
  if (observed.length === 0 && !motion) {
    const emd = parseEventMotionDescription(params.eventMotionDescription);
    if (emd) {
      observed = emd.observed;
      motion = emd.motion;
    }
  }
  if (observed.length === 0 && !motion) return [];

  const { hazard } = classifyNwsEvent(alert.event);
  const features: GeoJSON.Feature<StormTrackGeometry>[] = [];

  if (observed.length >= 2) {
    features.push({
      type: 'Feature',
      id: `${alert.id}-track-obs`,
      geometry: { type: 'LineString', coordinates: observed },
      properties: {
        alert_id: alert.id,
        event: alert.event,
        hazard,
        segment: 'observed',
      },
    });
  } else if (observed.length === 1 && motion) {
    features.push({
      type: 'Feature',
      id: `${alert.id}-track-obs`,
      geometry: { type: 'LineString', coordinates: observed },
      properties: {
        alert_id: alert.id,
        event: alert.event,
        hazard,
        segment: 'observed',
        point: true,
      },
    });
  }

  const anchor = observed.length > 0 ? observed[observed.length - 1] : null;
  if (anchor && motion && motion.kts > 0) {
    const distKm = motion.kts * KTS_TO_KM_PER_MIN * forecastMinutes;
    const end = projectPoint(anchor[0], anchor[1], motion.deg, distKm);
    const forecastCoords =
      observed.length > 0 ? [anchor, end] : [anchor, end];
    features.push({
      type: 'Feature',
      id: `${alert.id}-track-fcst`,
      geometry: { type: 'LineString', coordinates: forecastCoords },
      properties: {
        alert_id: alert.id,
        event: alert.event,
        hazard,
        segment: 'forecast',
        motion_deg: motion.deg,
        motion_kts: motion.kts,
        forecast_min: forecastMinutes,
      },
    });
    // Arrowhead + speed-label point at the projected endpoint. Two symbol
    // layers in RadarView read this feature: one renders a rotating arrow
    // glyph (text-rotate = motion_deg), the other an upright "{kts} kt"
    // label offset above. Distinguished from observed-track points by
    // `kind: 'forecast-end'`.
    features.push({
      type: 'Feature',
      id: `${alert.id}-track-fcst-end`,
      geometry: { type: 'Point', coordinates: end },
      properties: {
        alert_id: alert.id,
        event: alert.event,
        hazard,
        kind: 'forecast-end',
        motion_deg: motion.deg,
        motion_kts: motion.kts,
        forecast_min: forecastMinutes,
      },
    });
  }

  return features;
}

export function buildStormTracksCollection(
  alerts: StormTrackInput[],
): GeoJSON.FeatureCollection<StormTrackGeometry> {
  const features: GeoJSON.Feature<StormTrackGeometry>[] = [];
  for (const a of alerts) {
    features.push(...stormTracksFromAlert(a));
  }
  return { type: 'FeatureCollection', features };
}

export const STORM_TRACK_LINE_COLOR: any = [
  'match',
  ['get', 'hazard'],
  'tornado',
  '#f87171',
  'severe',
  '#fb923c',
  'flood',
  '#34d399',
  '#fbbf24',
];
