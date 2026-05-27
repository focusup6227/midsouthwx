// Render a polygon snapshot for operator-composed alerts that target an
// audience by geometry (radar-drawn polygon or circle). Calls the local
// LibreWxR+Mapbox stitcher so we stay off the Fly renderer's memory budget.
//
// Failure mode is "skip the snapshot, send text only" — returns null on any
// error and the caller proceeds without media.

import { renderReflectivitySnapshot } from '@/lib/snapshot/reflectivity-render';

type CircleSpec = { type: 'circle'; center: [number, number]; radius_km: number };
type GeoJsonGeom = { type: string; coordinates: unknown };
type GeometrySpec = CircleSpec | GeoJsonGeom;
type Polygonish =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

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
 * that the stitcher accepts. Returns null when the geometry isn't representable
 * (e.g., 'track' corridors — those would need buffering before drawing).
 */
function normalizeGeometry(g: unknown): Polygonish | null {
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
      return { type: 'Polygon', coordinates: coords as number[][][] };
    }
    if (typeof first[0] === 'number') {
      return { type: 'Polygon', coordinates: [coords as number[][]] };
    }
    return null;
  }

  if (t === 'multipolygon') {
    return { type: 'MultiPolygon', coordinates: geom.coordinates as number[][][][] };
  }

  return null;
}

export async function renderComposeSnapshot(
  messageId: string,
  geometry: unknown,
  opts: { event?: string } = {},
): Promise<string | null> {
  const polygon = normalizeGeometry(geometry);
  if (!polygon) return null;
  return renderReflectivitySnapshot({
    alertId: messageId,
    geometry: polygon,
    event: opts.event ?? 'Operator Alert',
  });
}
