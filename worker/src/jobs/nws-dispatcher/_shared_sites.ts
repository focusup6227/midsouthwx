// CONUS NEXRAD WSR-88D site centers, copied from lib/radar/sites.ts so this
// Edge Function (Deno) doesn't import from the Next app (Node + alias paths).
// Kept short — only sites in the Mid-South operational region. Add more if
// the dispatcher ever serves warnings outside this box.

export type RadarSite = {
  code: string;
  state: string;
  center: [number, number]; // [lon, lat]
};

export const NEXRAD_SITES: RadarSite[] = [
  // Tennessee
  { code: 'KNQA', state: 'TN', center: [-89.87, 35.34] },
  { code: 'KOHX', state: 'TN', center: [-86.56, 36.25] },
  { code: 'KMRX', state: 'TN', center: [-83.40, 36.17] },
  // Mississippi
  { code: 'KDGX', state: 'MS', center: [-89.98, 32.28] },
  { code: 'KGWX', state: 'MS', center: [-88.33, 33.90] },
  // Arkansas
  { code: 'KLZK', state: 'AR', center: [-92.26, 34.84] },
  { code: 'KSRX', state: 'AR', center: [-94.36, 35.29] },
  // Alabama
  { code: 'KBMX', state: 'AL', center: [-86.77, 33.17] },
  { code: 'KHTX', state: 'AL', center: [-86.08, 34.93] },
  { code: 'KMOB', state: 'AL', center: [-88.24, 30.68] },
  // Louisiana
  { code: 'KLIX', state: 'LA', center: [-89.83, 30.34] },
  { code: 'KSHV', state: 'LA', center: [-93.84, 32.45] },
  // Missouri
  { code: 'KSGF', state: 'MO', center: [-93.40, 37.24] },
  { code: 'KLSX', state: 'MO', center: [-90.68, 38.69] },
  // Kentucky
  { code: 'KPAH', state: 'KY', center: [-88.77, 37.07] },
  { code: 'KHPX', state: 'KY', center: [-87.29, 36.74] },
  { code: 'KLVX', state: 'KY', center: [-85.94, 37.98] },
];

/** Approximate great-circle distance in km using the haversine formula.
 *  Inputs are decimal degrees. Plenty of precision for nearest-site ranking. */
function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const c =
    s1 * s1 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
}

/** Pick the NEXRAD site closest to a polygon centroid. Returns null if the
 *  geometry has no usable coordinates (caller skips the loop request). */
export function nearestNexradSite(
  polygon: { type?: string; coordinates?: unknown } | null,
): RadarSite | null {
  if (!polygon || !polygon.coordinates) return null;
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  const walkRing = (ring: unknown) => {
    if (!Array.isArray(ring)) return;
    for (const pt of ring) {
      if (Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number') {
        sumX += pt[0];
        sumY += pt[1];
        n++;
      }
    }
  };
  const coords = polygon.coordinates as unknown[];
  if (polygon.type === 'Polygon') {
    for (const ring of coords) walkRing(ring);
  } else if (polygon.type === 'MultiPolygon') {
    for (const poly of coords) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) walkRing(ring);
    }
  } else {
    return null;
  }
  if (n === 0) return null;
  const centroid: [number, number] = [sumX / n, sumY / n];
  let best: RadarSite | null = null;
  let bestKm = Infinity;
  for (const site of NEXRAD_SITES) {
    const d = haversineKm(centroid, site.center);
    if (d < bestKm) {
      bestKm = d;
      best = site;
    }
  }
  // Reject if the closest site is unrealistically far (operator's warning
  // is outside our covered area) — better to skip the loop than render a
  // distant site that won't show the storm.
  if (bestKm > 350) return null;
  return best;
}
