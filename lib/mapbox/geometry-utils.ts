// Shared map-bounds math for the Mapbox alert / check-in views.

export type LngLatBoundsArray = [[number, number], [number, number]];

// [[minLon, minLat], [maxLon, maxLat]] over a (Multi)Polygon's rings plus any
// extra [lon, lat] points (e.g. subscriber pins). Non-finite coordinates are
// skipped; returns null when nothing usable was provided.
export function boundsFromGeometry(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null,
  extraPoints: ReadonlyArray<readonly [number, number]> = [],
): LngLatBoundsArray | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let any = false;
  const include = (lon: number, lat: number) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    any = true;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };
  for (const [lon, lat] of extraPoints) include(lon, lat);
  if (geometry) {
    const rings =
      geometry.type === 'Polygon'
        ? geometry.coordinates
        : geometry.coordinates.flat();
    for (const ring of rings) {
      for (const [lon, lat] of ring as [number, number][]) include(lon, lat);
    }
  }
  if (!any) return null;
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}
