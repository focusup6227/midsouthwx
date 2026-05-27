// Render a polygon snapshot for operator-composed alerts that target an
// audience by geometry (radar-drawn polygon or circle). Mirrors the
// nws-dispatcher snapshot path but called from the compose server action.
//
// Failure mode is "skip the snapshot, send text only" — the helper returns
// null on any error and the caller proceeds without media.

type CircleSpec = { type: 'circle'; center: [number, number]; radius_km: number };
type GeoJsonGeom = { type: string; coordinates: unknown };
type GeometrySpec = CircleSpec | GeoJsonGeom;

const REQUEST_TIMEOUT_MS = 25_000;
const CIRCLE_SEGMENTS = 32;

function circleToPolygon(
  center: [number, number],
  radiusKm: number,
): { type: 'Polygon'; coordinates: number[][][] } {
  const [lon, lat] = center;
  const kmPerDegLat = 111.32;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const kmPerDegLon = cosLat > 1e-9 ? 111.32 * cosLat : 111.32;
  const ring: number[][] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const theta = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
    const dx = (radiusKm * Math.sin(theta)) / kmPerDegLon;
    const dy = (radiusKm * Math.cos(theta)) / kmPerDegLat;
    ring.push([lon + dx, lat + dy]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/**
 * Normalize compose audience_spec.geometry to a GeoJSON Polygon|MultiPolygon
 * that the renderer's /alert-snapshot endpoint accepts. Returns null when
 * the geometry isn't representable (e.g., 'track' corridors — those would
 * need buffering before they're drawable as a polygon).
 */
function normalizeGeometry(g: unknown): { type: string; coordinates: unknown } | null {
  if (!g || typeof g !== 'object') return null;
  const geom = g as Partial<GeometrySpec> & { type?: string; coordinates?: unknown };
  if (typeof geom.type !== 'string') return null;
  const t = geom.type.toLowerCase();

  if (t === 'circle') {
    const c = g as CircleSpec;
    if (!Array.isArray(c.center) || c.center.length < 2) return null;
    if (typeof c.radius_km !== 'number' || c.radius_km <= 0) return null;
    return circleToPolygon([c.center[0], c.center[1]], c.radius_km);
  }

  if (t === 'polygon') {
    // Two shapes in the wild:
    //   GeoJSON Polygon: coordinates = [ring, hole?, ...] where ring = [[lon,lat],...]
    //   Flat polygon (RadarView selection): coordinates = [[lon,lat], ...] (single ring)
    const coords = geom.coordinates;
    if (!Array.isArray(coords) || coords.length === 0) return null;
    const first = coords[0];
    if (!Array.isArray(first)) return null;
    if (Array.isArray(first[0])) {
      // Already nested rings — valid GeoJSON Polygon.
      return { type: 'Polygon', coordinates: coords };
    }
    if (typeof first[0] === 'number') {
      // Single flat ring — wrap one level deeper.
      return { type: 'Polygon', coordinates: [coords] };
    }
    return null;
  }

  if (t === 'multipolygon') {
    return { type: 'MultiPolygon', coordinates: geom.coordinates };
  }

  // 'track' (storm-corridor LineString + width) — not snapshot-able without
  // a buffering step. Skip; operator's text-only alert still goes out.
  return null;
}

export async function renderComposeSnapshot(
  messageId: string,
  geometry: unknown,
  opts: { event?: string } = {},
): Promise<string | null> {
  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) return null;

  const polygon = normalizeGeometry(geometry);
  if (!polygon) return null;

  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/alert-snapshot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        alert_id: messageId,
        // Event hint drives polygon color in alert_snapshot.py. Pulls from
        // the operator's optional template_vars.event (e.g., "Tornado
        // Warning"); falls back to neutral slate when unset.
        event: opts.event ?? 'Operator Alert',
        polygon,
        observed: [],
        forecast: [],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(
        '[compose-snapshot] renderer rejected',
        resp.status,
        body.slice(0, 200),
      );
      return null;
    }

    const data = (await resp.json()) as { url?: string };
    return data.url ?? null;
  } catch (e) {
    console.error('[compose-snapshot] call failed', e);
    return null;
  }
}
