// Edge-safe Web Mercator helpers for projecting GeoJSON polygons onto a
// Mapbox Static Images basemap so a Satori <svg> overlay lines up pixel-for-
// pixel. Mirrors the math in lib/snapshot/reflectivity-render.ts (planViewport)
// but emits SVG path strings instead of compositing with sharp, so it runs in
// the edge runtime. The 256-px tile convention matches Mapbox Static's `zoom`
// query parameter (see the note in reflectivity-render.ts).

export type Bbox = [number, number, number, number]; // [west, south, east, north]

const TILE = 256;
const EARTH_CIRCUMFERENCE_M = 40075016.686;

function lonLatToMercatorM(lon: number, lat: number): [number, number] {
  const x = (lon * 20037508.34) / 180;
  const yRad = Math.log(Math.tan(((90 + lat) * Math.PI) / 360));
  return [x, (yRad * 20037508.34) / Math.PI];
}
function mercatorMToLonLat(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  const lat = (Math.atan(Math.sinh((y / 20037508.34) * Math.PI)) * 180) / Math.PI;
  return [lon, lat];
}

export type Viewport = { centerLng: number; centerLat: number; zoom: number };

/** Largest center+zoom that frames `bbox` inside a w×h image. */
export function planViewport(bbox: Bbox, w: number, h: number): Viewport {
  const [west, south, east, north] = bbox;
  const [xW, yS] = lonLatToMercatorM(west, south);
  const [xE, yN] = lonLatToMercatorM(east, north);
  const zoomW = Math.log2((w * EARTH_CIRCUMFERENCE_M) / (TILE * (xE - xW)));
  const zoomH = Math.log2((h * EARTH_CIRCUMFERENCE_M) / (TILE * (yN - yS)));
  const zoom = Math.min(zoomW, zoomH);
  const [centerLng, centerLat] = mercatorMToLonLat((xW + xE) / 2, (yS + yN) / 2);
  return { centerLng, centerLat, zoom };
}

/** Global Mercator pixel position at a given zoom (256-px tile scale). */
function worldPx(lng: number, lat: number, scale: number): [number, number] {
  const x = ((lng + 180) / 360) * scale;
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return [x, y];
}

export type Projector = (lng: number, lat: number) => [number, number];

/** lon/lat → image pixel for a Mapbox Static center+zoom request of size w×h. */
export function makeProjector(vp: Viewport, w: number, h: number): Projector {
  const scale = TILE * Math.pow(2, vp.zoom);
  const [cx, cy] = worldPx(vp.centerLng, vp.centerLat, scale);
  const originX = cx - w / 2;
  const originY = cy - h / 2;
  return (lng, lat) => {
    const [x, y] = worldPx(lng, lat, scale);
    return [x - originX, y - originY];
  };
}

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** Build an SVG path `d` for every ring of a (Multi)Polygon, projected to px. */
export function geometryToPath(geom: PolyGeom, project: Projector): string {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let d = '';
  for (const poly of polys) {
    for (const ring of poly) {
      ring.forEach((pt, i) => {
        const [x, y] = project(pt[0], pt[1]);
        d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
      });
      d += 'Z ';
    }
  }
  return d.trim();
}

/** Quick reject so we only draw geometry that intersects the framed bbox. */
export function geometryIntersectsBbox(geom: PolyGeom, bbox: Bbox): boolean {
  const [w, s, e, n] = bbox;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    const outer = poly[0] ?? [];
    for (const [lng, lat] of outer) {
      if (lng >= w && lng <= e && lat >= s && lat <= n) return true;
    }
  }
  return false;
}

/** Even-odd ray cast against a single polygon's rings (holes included). */
function pointInPolygon(rings: number[][][], lng: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const crosses = yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

/**
 * True overlap test between a (Multi)Polygon and a bbox. Unlike
 * `geometryIntersectsBbox` (vertex-in-bbox only), this also catches the case
 * where a large risk band fully encloses the framed area — important when we
 * headline the highest SPC category over the Mid-South: a SLGT/ENH band that
 * wraps the whole region has no vertices inside the small AOR box, but still
 * covers it. Checks polygon vertices in the box plus box corners/center in the
 * polygon, which together cover every realistic outlook shape.
 */
export function bboxOverlapsGeometry(geom: PolyGeom, bbox: Bbox): boolean {
  if (geometryIntersectsBbox(geom, bbox)) return true;
  const [w, s, e, n] = bbox;
  const probes: [number, number][] = [
    [w, s], [e, s], [e, n], [w, n], [(w + e) / 2, (s + n) / 2],
  ];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const [lng, lat] of probes) {
      if (pointInPolygon(poly, lng, lat)) return true;
    }
  }
  return false;
}
