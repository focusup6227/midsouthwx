// Stitch a LibreWxR reflectivity mosaic over a Mapbox dark basemap with the
// warning polygon outlined on top, upload to Supabase Storage, return URL.
// Runs as a regular Node function (server action or Vercel route handler) so
// we don't depend on the Fly renderer's heavier Py-ART path.
//
// Failure mode is "return null" — the caller falls back to the basemap-only
// PNG via the renderer's /alert-snapshot.

import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/server';
import { NEXRAD_SITES, distanceKm } from '@/lib/radar/sites';

const LIBREWXR_INDEX_URL = 'https://api.librewxr.net/public/weather-maps.json';
const LIBREWXR_TILE_SIZE = 512;
// LibreWxR caps at z7; Mapbox auto-scales beyond that, so we treat z7 as the
// upstream resolution and scale-fit into the output dimensions client-side.
const LIBREWXR_MAX_ZOOM = 7;
const LIBREWXR_COLOR_SCHEME = 9;     // NWS Reflectivity — matches /radar default
const LIBREWXR_OPTS = '1_1';         // smoothed + snow-aware

const OUTPUT_W = 800;
const OUTPUT_H = 600;
const BBOX_PADDING = 0.25;           // 25% padding around polygon bbox
const TILE_FETCH_TIMEOUT_MS = 8_000;
const BASEMAP_FETCH_TIMEOUT_MS = 12_000;
const NCEP_FETCH_TIMEOUT_MS = 12_000;
const RADAR_OPACITY = 0.78;
// WSR-88D scans out to ~230 km. Beyond that the per-site BREF image is
// mostly empty, so we fall back to the CONUS LibreWxR composite for the
// faraway-polygon case rather than ship a snapshot with no data.
const BREF_SITE_MAX_KM = 250;

const SNAPSHOT_BUCKET = 'alert-snapshots';

type Geometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

type Bbox = [number, number, number, number]; // [west, south, east, north]

/** Flatten a Polygon/MultiPolygon to the list of exterior rings. */
function exteriorRings(geom: Geometry): number[][][] {
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  return geom.coordinates.map((poly) => poly[0]);
}

function polygonBbox(geom: Geometry, paddingFrac = BBOX_PADDING): Bbox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (lon: number, lat: number) => {
    if (lon < west) west = lon;
    if (lat < south) south = lat;
    if (lon > east) east = lon;
    if (lat > north) north = lat;
  };
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) for (const [lon, lat] of ring) visit(lon, lat);
  } else {
    for (const poly of geom.coordinates)
      for (const ring of poly) for (const [lon, lat] of ring) visit(lon, lat);
  }
  const dx = Math.max((east - west) * paddingFrac, 0.05);
  const dy = Math.max((north - south) * paddingFrac, 0.05);
  return [west - dx, south - dy, east + dx, north + dy];
}

/** Web Mercator tile math — same projection LibreWxR + Mapbox both use. */
function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}
function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

type LwxrIndex = { host: string; latestPath: string };

async function fetchLwxrIndex(): Promise<LwxrIndex | null> {
  try {
    const r = await fetch(LIBREWXR_INDEX_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      host?: string;
      radar?: { nowcast?: { time: number; path: string }[]; past?: { time: number; path: string }[] };
    };
    const host = j.host;
    const past = j.radar?.past ?? [];
    const nowcast = j.radar?.nowcast ?? [];
    // Prefer the latest observed frame over a nowcast extrapolation — alert
    // recipients are reading "current radar," not a forecast.
    const latest = past[past.length - 1] ?? nowcast[0];
    if (!host || !latest) return null;
    return { host, latestPath: latest.path };
  } catch {
    return null;
  }
}

async function fetchBuffer(url: string, timeoutMs: number): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

/** Pixel mapping from lon/lat to image coords (linear; small-bbox safe). */
function makeProjector(bbox: Bbox, width: number, height: number) {
  const [west, south, east, north] = bbox;
  return (lon: number, lat: number): [number, number] => {
    const x = ((lon - west) / (east - west)) * width;
    const y = ((north - lat) / (north - south)) * height;
    return [x, y];
  };
}

/** Color the polygon outline by hazard, matching the live radar palette. */
function polygonStyle(event: string): { fill: string; stroke: string } {
  const e = event.toLowerCase();
  if (e.includes('tornado')) return { fill: '#dc2626', stroke: '#fecaca' };
  if (e.includes('flash flood') || e.includes('flood')) return { fill: '#16a34a', stroke: '#bbf7d0' };
  if (e.includes('severe thunderstorm') || e.includes('thunderstorm'))
    return { fill: '#ea580c', stroke: '#fed7aa' };
  if (e.includes('special marine') || e.includes('marine'))
    return { fill: '#0ea5e9', stroke: '#bae6fd' };
  return { fill: '#475569', stroke: '#cbd5e1' };
}

function polygonSvgOverlay(geom: Geometry, event: string, w: number, h: number, bbox: Bbox): Buffer {
  const project = makeProjector(bbox, w, h);
  const style = polygonStyle(event);
  const paths = exteriorRings(geom).map((ring) => {
    const d = ring
      .map(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    return `<path d="${d} Z" fill="${style.fill}" fill-opacity="0.18" stroke="${style.stroke}" stroke-width="2.5" stroke-linejoin="round"/>`;
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${paths.join('')}</svg>`,
  );
}

/** Web Mercator (EPSG:3857) projection of a lon/lat point in meters. NCEP's
 *  GeoServer accepts WMS bbox in CRS:3857 — we have to project the polygon's
 *  geographic bbox into meters before requesting the image. */
function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon * 20037508.34) / 180;
  const yRad = Math.log(Math.tan(((90 + lat) * Math.PI) / 360));
  const y = (yRad * 20037508.34) / Math.PI;
  return [x, y];
}

function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  const lat = (Math.atan(Math.sinh((y / 20037508.34) * Math.PI)) * 180) / Math.PI;
  return [lon, lat];
}

function bboxToMercatorString(bbox: Bbox): string {
  const [w, s, e, n] = bbox;
  const [xW, yS] = lonLatToMercator(w, s);
  const [xE, yN] = lonLatToMercator(e, n);
  return `${xW},${yS},${xE},${yN}`;
}

// Earth circumference in meters at the equator (Web Mercator). Used to map
// between zoom level and meters-per-pixel for the Mapbox Static center+zoom
// API. The `zoom` query parameter on Static Images follows the OSM/standard
// 256-px tile convention (zoom 0 = world in one 256x256 tile) — even though
// Mapbox's vector tiles are physically 512x512 internally. Using 512 here
// would make zoom one level too low and the rendered basemap would cover
// 2x the linear area we ask NCEP for, leaving the radar inside a wider basemap.
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const MAPBOX_TILE_SIZE = 256;

/** Plan the static-image viewport: from a polygon bbox, pick the center +
 *  zoom + final lon/lat bbox so a Mapbox center+zoom request and an NCEP WMS
 *  bbox request cover EXACTLY the same map area. Mapbox's `[lng,lat,lng,lat]`
 *  bbox-fit mode adds a hard-to-predict amount of padding; switching both
 *  upstreams to a shared center+zoom-derived bbox makes them align pixel for
 *  pixel. */
function planViewport(
  bbox: Bbox,
  w: number,
  h: number,
): { centerLng: number; centerLat: number; zoom: number; rendered: Bbox } {
  const [west, south, east, north] = bbox;
  const [xW, yS] = lonLatToMercator(west, south);
  const [xE, yN] = lonLatToMercator(east, north);
  const mercW = xE - xW;
  const mercH = yN - yS;

  // Largest zoom that still fits the bbox in both axes. log2 because each
  // zoom level halves the meters-per-pixel.
  const zoomW = Math.log2((w * EARTH_CIRCUMFERENCE_M) / (MAPBOX_TILE_SIZE * mercW));
  const zoomH = Math.log2((h * EARTH_CIRCUMFERENCE_M) / (MAPBOX_TILE_SIZE * mercH));
  const zoom = Math.min(zoomW, zoomH);

  // Center in Mercator (linear midpoint) → reproject to lon/lat for Mapbox.
  // The center is the same regardless of which axis was the constraint.
  const cxM = (xW + xE) / 2;
  const cyM = (yS + yN) / 2;
  const [centerLng, centerLat] = mercatorToLonLat(cxM, cyM);

  // From the chosen zoom, compute the actual rendered bbox in Mercator and
  // convert to lon/lat. Whichever axis Mapbox would have padded on bbox-fit
  // is now naturally extended here, and NCEP receives the same extent.
  const metersPerPixel = EARTH_CIRCUMFERENCE_M / (MAPBOX_TILE_SIZE * Math.pow(2, zoom));
  const halfW = (w / 2) * metersPerPixel;
  const halfH = (h / 2) * metersPerPixel;
  const renderedXW = cxM - halfW;
  const renderedXE = cxM + halfW;
  const renderedYS = cyM - halfH;
  const renderedYN = cyM + halfH;
  const [renderedWest, renderedSouth] = mercatorToLonLat(renderedXW, renderedYS);
  const [renderedEast, renderedNorth] = mercatorToLonLat(renderedXE, renderedYN);
  return {
    centerLng,
    centerLat,
    zoom,
    rendered: [renderedWest, renderedSouth, renderedEast, renderedNorth],
  };
}

type SitePick = { code: string; km: number };

/** All NEXRAD sites within `maxKm` of the bbox centroid, nearest first. Used
 *  to stitch overlapping BREF discs so the polygon isn't clipped at one
 *  site's ~230 km range. Returns up to `limit` sites — typical CONUS
 *  polygons land 3-5 sites in range. */
function sitesInRange(centroid: [number, number], maxKm: number, limit = 5): SitePick[] {
  const scored: SitePick[] = [];
  for (const s of NEXRAD_SITES) {
    const km = distanceKm(centroid, s.center);
    if (km <= maxKm) scored.push({ code: s.code, km });
  }
  scored.sort((a, b) => a.km - b.km);
  return scored.slice(0, limit);
}

function bboxCentroid(bbox: Bbox): [number, number] {
  const [w, s, e, n] = bbox;
  return [(w + e) / 2, (s + n) / 2];
}

/** NCEP GeoServer per-site BREF (lowest-elevation base reflectivity, 0.5°
 *  super-res). Same source `/radar` uses when the operator selects the
 *  "Base Reflectivity" product. Returns null on any HTTP error — caller
 *  falls back to the LibreWxR composite. */
async function fetchNcepBref(
  siteCode: string,
  bbox: Bbox,
  w: number,
  h: number,
): Promise<Buffer | null> {
  const site = siteCode.toLowerCase();
  const layer = `${site}:${site}_sr_bref`;
  const url =
    `https://opengeo.ncep.noaa.gov/geoserver/${site}/ows` +
    `?service=WMS&request=GetMap&version=1.3.0` +
    `&layers=${encodeURIComponent(layer)}&styles=` +
    `&format=image/png&transparent=true` +
    `&width=${w}&height=${h}&crs=EPSG:3857` +
    `&bbox=${bboxToMercatorString(bbox)}`;
  return fetchBuffer(url, NCEP_FETCH_TIMEOUT_MS);
}

/** Apply a uniform alpha multiplier to an RGBA layer so it composites at the
 *  desired transparency. dest-in blend with a single-pixel tile is the
 *  standard sharp idiom for "fade this whole image to N% alpha." */
async function applyOpacity(input: Buffer, opacity: number): Promise<Buffer> {
  return sharp(input)
    .ensureAlpha()
    .composite([
      {
        input: Buffer.from([255, 255, 255, Math.round(255 * opacity)]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer();
}

async function fetchMapboxBasemap(
  centerLng: number,
  centerLat: number,
  zoom: number,
  w: number,
  h: number,
  token: string,
): Promise<Buffer | null> {
  // Center+zoom (not bbox-fit) so we control the exact rendered extent and
  // can hand the matching bbox to NCEP for the radar overlay.
  const url =
    `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/` +
    `${centerLng},${centerLat},${zoom}/${w}x${h}@2x` +
    `?access_token=${token}&logo=false&attribution=false`;
  return fetchBuffer(url, BASEMAP_FETCH_TIMEOUT_MS);
}

/** Build the radar tile mosaic as a single layer the size of the basemap.
 *  Each LibreWxR tile is placed at its bbox-projected position; tiles that
 *  partially overlap the bbox are still composited (sharp clips the excess). */
async function buildRadarMosaic(
  bbox: Bbox,
  w: number,
  h: number,
  lwxr: LwxrIndex,
): Promise<Buffer | null> {
  const z = LIBREWXR_MAX_ZOOM;
  const xMin = Math.floor(lonToTileX(bbox[0], z));
  const xMax = Math.floor(lonToTileX(bbox[2], z));
  // LibreWxR uses standard slippy y (top-down) so south uses the larger y.
  const yMin = Math.floor(latToTileY(bbox[3], z));
  const yMax = Math.floor(latToTileY(bbox[1], z));

  const tileSpecs: { x: number; y: number; url: string }[] = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const url =
        `${lwxr.host}${lwxr.latestPath}/${LIBREWXR_TILE_SIZE}/${z}/${x}/${y}` +
        `/${LIBREWXR_COLOR_SCHEME}/${LIBREWXR_OPTS}.png`;
      tileSpecs.push({ x, y, url });
    }
  }
  if (tileSpecs.length === 0) return null;
  // Hard cap; a polygon spanning > 16 tiles at z7 is wider than a CWA and
  // wouldn't render usefully anyway.
  if (tileSpecs.length > 25) return null;

  const tiles = await Promise.all(
    tileSpecs.map(async (t) => {
      const buf = await fetchBuffer(t.url, TILE_FETCH_TIMEOUT_MS);
      return buf ? { ...t, buf } : null;
    }),
  );
  const ready = tiles.filter((t): t is { x: number; y: number; url: string; buf: Buffer } => !!t);
  if (ready.length === 0) return null;

  const project = makeProjector(bbox, w, h);
  // Place each tile. LibreWxR tiles align to a global slippy grid that almost
  // never matches the polygon bbox edges, so most tiles extend past the
  // canvas on one or more sides. Sharp's composite refuses any overlay that
  // doesn't fit entirely inside the base, so we crop each tile to just the
  // visible slice before placing.
  const overlays: (sharp.OverlayOptions | null)[] = await Promise.all(
    ready.map(async (t) => {
      const tileWestLon = tileXToLon(t.x, z);
      const tileEastLon = tileXToLon(t.x + 1, z);
      const tileNorthLat = tileYToLat(t.y, z);
      const tileSouthLat = tileYToLat(t.y + 1, z);
      const [xL, yT] = project(tileWestLon, tileNorthLat);
      const [xR, yB] = project(tileEastLon, tileSouthLat);
      const fullW = Math.max(1, Math.round(xR - xL));
      const fullH = Math.max(1, Math.round(yB - yT));
      const left = Math.round(xL);
      const top = Math.round(yT);

      // Visible region within the canvas, clamped to [0, w/h].
      const canvasLeft = Math.max(0, left);
      const canvasTop = Math.max(0, top);
      const canvasRight = Math.min(w, left + fullW);
      const canvasBottom = Math.min(h, top + fullH);
      const visibleW = canvasRight - canvasLeft;
      const visibleH = canvasBottom - canvasTop;
      if (visibleW <= 0 || visibleH <= 0) return null;

      // Corresponding region inside the resized tile.
      const cropLeft = canvasLeft - left;
      const cropTop = canvasTop - top;

      let pipeline = sharp(t.buf).resize(fullW, fullH, { fit: 'fill' });
      if (cropLeft !== 0 || cropTop !== 0 || visibleW !== fullW || visibleH !== fullH) {
        pipeline = pipeline.extract({
          left: cropLeft,
          top: cropTop,
          width: visibleW,
          height: visibleH,
        });
      }
      const cropped = await pipeline.png().toBuffer();
      return { input: cropped, left: canvasLeft, top: canvasTop };
    }),
  );
  const placed = overlays.filter((o): o is sharp.OverlayOptions => o !== null);
  if (placed.length === 0) return null;

  // Empty transparent canvas, then layer the cropped tiles.
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(placed)
    .png()
    .toBuffer();
}

export async function renderReflectivitySnapshot(args: {
  alertId: string;
  geometry: Geometry;
  event: string;
}): Promise<string | null> {
  const mapboxToken = process.env.MAPBOX_STATIC_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!mapboxToken) return null;

  const rawBbox = polygonBbox(args.geometry);
  // One viewport plan drives everything: Mapbox gets center+zoom, NCEP gets
  // the matching Mercator bbox, the polygon SVG projects to the same extent.
  // Eliminates the bbox-fit mismatch that left the radar inside a wider basemap.
  const viewport = planViewport(rawBbox, OUTPUT_W, OUTPUT_H);
  const bbox = viewport.rendered;
  // 5-minute wall-clock bucket in the cache key so long-lived alerts pick up
  // fresh radar scans instead of serving the first render for 30+ minutes.
  const bucketMs = 5 * 60 * 1000;
  const scanBucket = Math.floor(Date.now() / bucketMs);
  const cacheSeed = JSON.stringify({
    bbox,
    geom: args.geometry,
    event: args.event,
    bucket: scanBucket,
  });
  const cacheHash = createHash('sha1').update(cacheSeed).digest('hex').slice(0, 12);
  const path = `${args.alertId}/refl_${cacheHash}.png`;

  const admin = supabaseAdmin();

  // Storage-level cache: HEAD via the public URL to skip a re-render when
  // the same alert+scan combo was already produced this 5-min bucket.
  const { data: pub } = admin.storage.from(SNAPSHOT_BUCKET).getPublicUrl(path);
  if (pub?.publicUrl) {
    try {
      const head = await fetch(pub.publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(3_000) });
      if (head.ok) return pub.publicUrl;
    } catch {
      // miss is fine — fall through to render
    }
  }

  // Fetch BREF from every WSR-88D site within range of the polygon in
  // parallel — single-site coverage caps at ~230 km, so polygons sitting
  // between two sites need both stitched together to avoid hard cutoffs.
  // Same product `/radar` shows in BREF mode, just composited across sites.
  const sites = sitesInRange(bboxCentroid(bbox), BREF_SITE_MAX_KM);

  const basemapPromise = fetchMapboxBasemap(
    viewport.centerLng,
    viewport.centerLat,
    viewport.zoom,
    OUTPUT_W,
    OUTPUT_H,
    mapboxToken,
  );
  const brefPromises: Promise<Buffer | null>[] = sites.map((s) =>
    fetchNcepBref(s.code, bbox, OUTPUT_W, OUTPUT_H),
  );
  const [basemap, ...brefResults] = await Promise.all([basemapPromise, ...brefPromises]);
  if (!basemap) return null;

  const overlays: sharp.OverlayOptions[] = [];

  // Composite every successful BREF disc in nearest-first order. Each NCEP
  // PNG is transparent outside its site's range, so closer sites paint on
  // top of farther ones (where they overlap) at full strength; faraway
  // sites fill in the corners the nearest site can't reach.
  const successfulBrefs = brefResults.filter((b): b is Buffer => b !== null);
  if (successfulBrefs.length > 0) {
    for (const b of successfulBrefs) {
      const dimmed = await applyOpacity(b, RADAR_OPACITY);
      overlays.push({ input: dimmed });
    }
  } else {
    // No covered sites or NCEP entirely failed → fall back to LibreWxR
    // CONUS composite so the alert still ships a radar image.
    const lwxr = await fetchLwxrIndex();
    if (lwxr) {
      const mosaic = await buildRadarMosaic(bbox, OUTPUT_W, OUTPUT_H, lwxr);
      if (mosaic) overlays.push({ input: await applyOpacity(mosaic, RADAR_OPACITY) });
    }
  }

  // Polygon outline always on top.
  overlays.push({ input: polygonSvgOverlay(args.geometry, args.event, OUTPUT_W, OUTPUT_H, bbox) });

  let composedBuf: Buffer;
  try {
    composedBuf = await sharp(basemap).composite(overlays).png().toBuffer();
  } catch (e) {
    console.error('[reflectivity-render] composite failed', e);
    return null;
  }

  const { error: upErr } = await admin.storage
    .from(SNAPSHOT_BUCKET)
    .upload(path, composedBuf, {
      contentType: 'image/png',
      cacheControl: '31536000',
      upsert: true,
    });
  if (upErr) {
    console.error('[reflectivity-render] upload failed', upErr.message);
    return null;
  }
  return pub?.publicUrl ?? null;
}
