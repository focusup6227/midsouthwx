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

const LIBREWXR_INDEX_URL = 'https://api.librewxr.net/public/weather-maps.json';
const LIBREWXR_TILE_SIZE = 512;
// LibreWxR caps at z7; Mapbox auto-scales beyond that, so we treat z7 as the
// upstream resolution and scale-fit into the output dimensions client-side.
const LIBREWXR_MAX_ZOOM = 7;
const LIBREWXR_COLOR_SCHEME = 8;     // NWS Reflectivity palette
const LIBREWXR_OPTS = '1_1';         // smoothed + snow-aware

const OUTPUT_W = 800;
const OUTPUT_H = 600;
const BBOX_PADDING = 0.25;           // 25% padding around polygon bbox
const TILE_FETCH_TIMEOUT_MS = 8_000;
const BASEMAP_FETCH_TIMEOUT_MS = 12_000;
const RADAR_OPACITY = 0.78;

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

async function fetchMapboxBasemap(bbox: Bbox, w: number, h: number, token: string): Promise<Buffer | null> {
  const bboxStr = `[${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}]`;
  const url =
    `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${bboxStr}/${w}x${h}@2x` +
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
  // Place each tile. Resize via sharp first so composite gets the right
  // footprint; the placement is integer pixel because sharp's `left`/`top`
  // are pixel-aligned.
  const overlays: sharp.OverlayOptions[] = await Promise.all(
    ready.map(async (t) => {
      const tileWestLon = tileXToLon(t.x, z);
      const tileEastLon = tileXToLon(t.x + 1, z);
      const tileNorthLat = tileYToLat(t.y, z);
      const tileSouthLat = tileYToLat(t.y + 1, z);
      const [xL, yT] = project(tileWestLon, tileNorthLat);
      const [xR, yB] = project(tileEastLon, tileSouthLat);
      const tileW = Math.max(1, Math.round(xR - xL));
      const tileH = Math.max(1, Math.round(yB - yT));
      const left = Math.round(xL);
      const top = Math.round(yT);
      const resized = await sharp(t.buf).resize(tileW, tileH, { fit: 'fill' }).png().toBuffer();
      return { input: resized, left, top };
    }),
  );

  // Empty transparent canvas, then layer the resized tiles.
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(overlays)
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

  const bbox = polygonBbox(args.geometry);
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

  const [lwxr, basemap] = await Promise.all([
    fetchLwxrIndex(),
    fetchMapboxBasemap(bbox, OUTPUT_W, OUTPUT_H, mapboxToken),
  ]);
  if (!basemap) return null;

  // Always have the basemap to start. If LibreWxR is unavailable, we still
  // produce a polygon-on-basemap PNG — same outcome as the renderer's path,
  // but generated locally so we don't bounce a request to Fly.
  const overlays: sharp.OverlayOptions[] = [];
  if (lwxr) {
    const mosaic = await buildRadarMosaic(bbox, OUTPUT_W, OUTPUT_H, lwxr);
    if (mosaic) {
      // Apply opacity in a chained call so the original mosaic stays sharp.
      const dimmed = await sharp(mosaic)
        .ensureAlpha()
        .composite([
          {
            input: Buffer.from([255, 255, 255, Math.round(255 * RADAR_OPACITY)]),
            raw: { width: 1, height: 1, channels: 4 },
            tile: true,
            blend: 'dest-in',
          },
        ])
        .png()
        .toBuffer();
      overlays.push({ input: dimmed });
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
