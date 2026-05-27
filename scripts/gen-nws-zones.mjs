// Builds public/maps/nws-zones.geojson — a simplified FeatureCollection of
// every NWS forecast (public) zone and fire-weather zone, used by the
// /radar page as a static client GeoJSON source for zone outlines.
//
// Pure Node, no system deps (no GDAL, no tippecanoe).
//
// Run:  npm run gen:zones
//
// What it does:
//   1. Downloads the latest NWS public+fire zone shapefile ZIPs from
//      weather.gov (these are the canonical source — the /zones API
//      collection endpoint doesn't return geometry).
//   2. Unzips in memory (jszip), parses SHP+DBF with the `shapefile`
//      package, converts each record to a GeoJSON Feature.
//   3. Trims properties to {id, name, state, cwa, kind} and simplifies
//      geometry with @turf/simplify (~550 m tolerance) so the payload
//      stays in the few-MB range.
//   4. Writes a single FeatureCollection to public/maps/nws-zones.geojson.
//
// Re-run any time NWS updates their zones (a few times a year). The URLs
// below pin to a dated bundle so you can re-run deterministically.

import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import simplifyPkg from '@turf/simplify';
import JSZip from 'jszip';
import * as shapefile from 'shapefile';

const simplify = simplifyPkg.default ?? simplifyPkg;

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '..', 'public', 'maps', 'nws-zones.geojson');

// Douglas-Peucker tolerance in degrees. Zone polygons are tens-of-miles in
// scale and the radar map shows zone outlines mostly as visual reference,
// not for precise edge identification. 0.02° ≈ 2.2 km — invisible at the
// state-level zooms the operator uses, keeps the payload under ~3 MB.
// Bump down to 0.01 for sharper coastal outlines (file ~2-3x bigger);
// up to 0.04 for tighter file size.
// 0.04° ≈ 4.4 km. Looks ~1 pixel at zoom 4, sub-pixel at zoom 6. Anything
// finer than that adds bytes the operator can't see at typical radar zoom.
const SIMPLIFY_TOL = 0.04;
// Decimal places to keep on lon/lat. 3 dp ≈ 110 m precision, far finer than
// the simplify tolerance, and shaves a lot off the JSON payload vs raw
// double-precision floats.
const COORD_DECIMALS = 3;

// NWS publishes these as dated shapefile bundles. Refresh by browsing
// https://www.weather.gov/gis/PublicZones and ../FireZones, then updating
// the filenames below to the newest effective-date bundle.
//   Last validated: 2026-05 (NWS 2026-04-16 effective bundle).
const SOURCES = [
  {
    kind: 'forecast',
    url: 'https://www.weather.gov/source/gis/Shapefiles/WSOM/z_16ap26.zip',
    shp: 'z_16ap26.shp',
    dbf: 'z_16ap26.dbf',
  },
  {
    kind: 'fire',
    url: 'https://www.weather.gov/source/gis/Shapefiles/WSOM/fz16ap26.zip',
    shp: 'fz16ap26.shp',
    dbf: 'fz16ap26.dbf',
  },
];

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'midsouthwx zone-gen' },
  });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// US states + DC + PR + Guam + USVI. Anything outside this is a marine /
// offshore zone (AM, PK, AN, PZ, GM, LM, etc.) — those have huge coastline
// polygons that bloat the file with no value for a land radar.
const LAND_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
  'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY','PR','VI','GU','AS','MP',
]);

function trimProps(p, kind) {
  return {
    id: p?.STATE_ZONE ?? p?.ZONE ?? null,
    name: p?.NAME ?? p?.SHORTNAME ?? null,
    state: p?.STATE ?? null,
    cwa: p?.CWA ?? null,
    kind,
  };
}

async function readShapefileFromZip(buf, shpName, dbfName, kind) {
  const zip = await JSZip.loadAsync(buf);

  // Some bundles nest the files in a subfolder; scan all entries.
  const findFile = (name) => {
    for (const entryName of Object.keys(zip.files)) {
      if (entryName.toLowerCase().endsWith('/' + name.toLowerCase())
          || entryName.toLowerCase() === name.toLowerCase()) {
        return zip.files[entryName];
      }
    }
    return null;
  };

  const shpEntry = findFile(shpName);
  const dbfEntry = findFile(dbfName);
  if (!shpEntry || !dbfEntry) {
    throw new Error(`zip missing ${shpName} or ${dbfName}`);
  }

  const shpBuf = await shpEntry.async('nodebuffer');
  const dbfBuf = await dbfEntry.async('nodebuffer');

  // shapefile.open accepts ArrayBuffer for both — convert from Buffer.
  const toAb = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const source = await shapefile.open(toAb(shpBuf), toAb(dbfBuf));

  const features = [];
  while (true) {
    const r = await source.read();
    if (r.done) break;
    const feat = r.value;
    if (!feat?.geometry) continue;
    const t = feat.geometry.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
    const state = feat.properties?.STATE ?? null;
    if (state && !LAND_STATES.has(state)) continue;
    features.push({
      type: 'Feature',
      geometry: feat.geometry,
      properties: trimProps(feat.properties, kind),
    });
  }
  return features;
}

function simplifyFeature(feature, tolerance) {
  try {
    return simplify(feature, { tolerance, highQuality: false, mutate: false });
  } catch {
    // Pathological polygons (collinear rings) sometimes break the simplifier.
    // Fall back to the unsimplified geometry — still useful at zoom-out.
    return feature;
  }
}

const ROUND_FACTOR = 10 ** COORD_DECIMALS;
function roundCoord(c) {
  return [Math.round(c[0] * ROUND_FACTOR) / ROUND_FACTOR, Math.round(c[1] * ROUND_FACTOR) / ROUND_FACTOR];
}
function roundRing(ring) { return ring.map(roundCoord); }
function roundCoordsInPlace(geom) {
  if (geom.type === 'Polygon') {
    geom.coordinates = geom.coordinates.map(roundRing);
  } else if (geom.type === 'MultiPolygon') {
    geom.coordinates = geom.coordinates.map((poly) => poly.map(roundRing));
  }
}

async function main() {
  const all = [];
  for (const src of SOURCES) {
    console.log(`[${src.kind}] downloading ${src.url}`);
    const zipBuf = await fetchBuffer(src.url);
    console.log(`[${src.kind}] parsing shapefile (${(zipBuf.length / 1024).toFixed(0)} KB zip)`);
    const raw = await readShapefileFromZip(zipBuf, src.shp, src.dbf, src.kind);
    console.log(`[${src.kind}] got ${raw.length} features, simplifying…`);
    for (const f of raw) {
      const s = simplifyFeature(f, SIMPLIFY_TOL);
      if (s?.geometry) roundCoordsInPlace(s.geometry);
      all.push(s);
    }
  }

  const fc = { type: 'FeatureCollection', features: all };
  mkdirSync(dirname(outPath), { recursive: true });
  const json = JSON.stringify(fc);
  writeFileSync(outPath, json);
  console.log(`✓ wrote ${outPath} (${all.length} features, ${(json.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
