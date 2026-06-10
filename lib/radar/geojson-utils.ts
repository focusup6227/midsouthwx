// Shared GeoJSON coercion for the /api/radar route handlers. Supabase RPCs
// return jsonb as `unknown`; this narrows it to a typed FeatureCollection,
// falling back to an empty collection on anything malformed so the radar
// map never crashes on a bad payload.

export function parseFeatureCollection<G extends GeoJSON.Geometry = GeoJSON.Geometry>(
  raw: unknown,
): GeoJSON.FeatureCollection<G> {
  if (!raw || typeof raw !== 'object') {
    return { type: 'FeatureCollection', features: [] };
  }
  const o = raw as { type?: string; features?: unknown[] };
  if (o.type !== 'FeatureCollection' || !Array.isArray(o.features)) {
    return { type: 'FeatureCollection', features: [] };
  }
  return o as GeoJSON.FeatureCollection<G>;
}
