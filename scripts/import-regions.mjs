// Import regions (counties + NWS forecast zones) into public.regions.
// Idempotent — upserts on the partial unique indexes (county_fips / ugc_code).
// The regions_after_change trigger refreshes subscriber_regions automatically.
//
// Usage:
//   node scripts/import-regions.mjs --counties 47,28,05
//     Census TIGER county boundaries for the given state FIPS codes (47=TN, 28=MS, 05=AR).
//
//   node scripts/import-regions.mjs --zones TN,MS,AR
//     NWS forecast zones for the given state postal codes.
//
//   node scripts/import-regions.mjs --file path/to/regions.geojson
//     Local GeoJSON FeatureCollection; each feature needs
//     properties.kind ('county'|'zone'|'custom_polygon'),
//     properties.name, and properties.county_fips or properties.ugc_code.
//
// Reads .env.local for NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
// Reads NWS_USER_AGENT from .env.local; required for api.weather.gov calls.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env.local');

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.counties && !args.zones && !args.file) {
  console.error(
    'Usage:\n' +
      '  node scripts/import-regions.mjs --counties 47,28,05\n' +
      '  node scripts/import-regions.mjs --zones TN,MS,AR\n' +
      '  node scripts/import-regions.mjs --file path/to/regions.geojson',
  );
  process.exit(1);
}

const supaHeaders = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json',
};

let total = 0;
let failed = 0;

if (args.counties) {
  for (const statefp of args.counties.split(',').map((s) => s.trim()).filter(Boolean)) {
    await importCounties(statefp);
  }
}
if (args.zones) {
  for (const state of args.zones.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    await importZones(state);
  }
}
if (args.file) {
  await importFile(args.file);
}

console.log(`\nDone. Upserted ${total} region(s); ${failed} failure(s).`);
if (failed > 0) process.exit(1);

// ── implementations ─────────────────────────────────────────────────────────

async function importCounties(statefp) {
  console.log(`\nFetching Census TIGER counties for state FIPS ${statefp}…`);
  // Census Cartographic Boundary, 20m generalization (good enough for routing).
  const url =
    'https://services2.arcgis.com/jUpNdisbWqRpMo35/ArcGIS/rest/services/' +
    'Census_Counties_2022/FeatureServer/0/query' +
    `?where=STATEFP%3D'${encodeURIComponent(statefp)}'` +
    '&outFields=STATEFP,COUNTYFP,NAME,NAMELSAD&outSR=4326&f=geojson';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    console.error(`  fetch failed: ${res.status}`);
    failed++;
    return;
  }
  const fc = await res.json();
  for (const feat of fc.features ?? []) {
    const fips = `${feat.properties.STATEFP}${feat.properties.COUNTYFP}`;
    const name = `${feat.properties.NAMELSAD ?? feat.properties.NAME} (${stateAbbrFromFips(statefp)})`;
    await upsert({
      name,
      kind: 'county',
      county_fips: fips,
      ugc_code: null,
      geojson: JSON.stringify(feat.geometry),
    });
  }
}

async function importZones(stateAbbr) {
  const ua = env.NWS_USER_AGENT;
  if (!ua) {
    console.error('  NWS_USER_AGENT missing in .env.local; api.weather.gov requires one.');
    failed++;
    return;
  }
  console.log(`\nFetching NWS forecast zones for state ${stateAbbr}…`);
  const url = `https://api.weather.gov/zones?area=${encodeURIComponent(stateAbbr)}&type=forecast&include_geometry=true&limit=500`;
  const res = await fetch(url, {
    headers: { accept: 'application/geo+json', 'user-agent': ua },
  });
  if (!res.ok) {
    console.error(`  fetch failed: ${res.status}`);
    failed++;
    return;
  }
  const fc = await res.json();
  for (const feat of fc.features ?? []) {
    const ugc = feat.properties.id || feat.properties.code;
    if (!ugc) continue;
    if (!feat.geometry) {
      console.warn(`  ${ugc}: no geometry, skipping`);
      continue;
    }
    const name = `${feat.properties.name} (${stateAbbr})`;
    await upsert({
      name,
      kind: 'zone',
      county_fips: null,
      ugc_code: ugc,
      geojson: JSON.stringify(feat.geometry),
    });
  }
}

async function importFile(path) {
  console.log(`\nReading ${path}…`);
  const fc = JSON.parse(readFileSync(path, 'utf8'));
  const features = fc.type === 'FeatureCollection' ? fc.features : [fc];
  for (const feat of features) {
    const props = feat.properties ?? {};
    const kind = props.kind ?? 'custom_polygon';
    if (!['county', 'zone', 'custom_polygon'].includes(kind)) {
      console.warn(`  skipping unknown kind: ${kind}`);
      continue;
    }
    if (!props.name) {
      console.warn('  feature missing properties.name, skipping');
      continue;
    }
    await upsert({
      name: props.name,
      kind,
      county_fips: props.county_fips ?? null,
      ugc_code: props.ugc_code ?? null,
      geojson: feat.geometry ? JSON.stringify(feat.geometry) : null,
    });
  }
}

async function upsert({ name, kind, county_fips, ugc_code, geojson }) {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/upsert_region_geojson`, {
    method: 'POST',
    headers: supaHeaders,
    body: JSON.stringify({
      p_name: name,
      p_kind: kind,
      p_county_fips: county_fips,
      p_ugc_code: ugc_code,
      p_geojson: geojson,
    }),
  });
  if (!res.ok) {
    console.error(`  ${name}: ${res.status} ${await res.text()}`);
    failed++;
    return;
  }
  total++;
  if (total % 10 === 0) process.stdout.write(`  …${total}\n`);
  else process.stdout.write('.');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function stateAbbrFromFips(fips) {
  const map = {
    '01': 'AL', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
    '09': 'CT', '10': 'DE', '12': 'FL', '13': 'GA', '16': 'ID',
    '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
    '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI',
    '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
    '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY',
    '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR',
    '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN',
    '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
    '54': 'WV', '55': 'WI', '56': 'WY',
  };
  return map[fips] ?? fips;
}
