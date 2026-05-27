// Server-side bulk import for counties (Census TIGERweb) and NWS forecast zones.
// Mirrors scripts/import-regions.mjs but called from a Next server action.

import { ABBR_TO_FIPS, FIPS_TO_ABBR } from './states';

export type ImportResult = {
  state: string;
  kind: 'county' | 'zone';
  upserted: number;
  failed: number;
  error?: string;
};

type Upserter = (row: {
  name: string;
  kind: 'county' | 'zone';
  county_fips: string | null;
  ugc_code: string | null;
  geojson: string;
}) => Promise<void>;

export async function importCounties(stateInput: string, upsert: Upserter): Promise<ImportResult> {
  const statefp = stateInputToFips(stateInput);
  if (!statefp) {
    return { state: stateInput, kind: 'county', upserted: 0, failed: 0, error: 'unknown state' };
  }
  const url =
    'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/13/query' +
    `?where=${encodeURIComponent(`STATE='${statefp}'`)}` +
    '&outFields=STATE,COUNTY,NAME,BASENAME' +
    '&outSR=4326&f=geojson';

  let fc: { features?: { geometry: GeoJSON.Geometry; properties: { STATE: string; COUNTY: string; NAME: string; BASENAME?: string } }[] };
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) {
      return { state: stateInput, kind: 'county', upserted: 0, failed: 0, error: `tigerweb ${res.status}` };
    }
    fc = await res.json();
  } catch (e) {
    return { state: stateInput, kind: 'county', upserted: 0, failed: 0, error: e instanceof Error ? e.message : String(e) };
  }

  const abbr = FIPS_TO_ABBR[statefp] ?? statefp;
  let upserted = 0;
  let failed = 0;
  for (const feat of fc.features ?? []) {
    const fips = `${feat.properties.STATE}${feat.properties.COUNTY}`;
    const base = feat.properties.BASENAME ?? feat.properties.NAME;
    try {
      await upsert({
        name: `${base} County (${abbr})`,
        kind: 'county',
        county_fips: fips,
        ugc_code: null,
        geojson: JSON.stringify(feat.geometry),
      });
      upserted++;
    } catch {
      failed++;
    }
  }
  return { state: abbr, kind: 'county', upserted, failed };
}

export async function importZones(
  stateAbbrIn: string,
  userAgent: string,
  upsert: Upserter,
  pool = 6,
): Promise<ImportResult> {
  const stateAbbr = stateAbbrIn.trim().toUpperCase();
  if (!(stateAbbr in ABBR_TO_FIPS)) {
    return { state: stateAbbr, kind: 'zone', upserted: 0, failed: 0, error: 'unknown state' };
  }
  if (!userAgent) {
    return { state: stateAbbr, kind: 'zone', upserted: 0, failed: 0, error: 'NWS_USER_AGENT not set' };
  }
  const headers = { accept: 'application/geo+json', 'user-agent': userAgent };

  let zoneIds: string[];
  try {
    const listUrl = `https://api.weather.gov/zones?area=${encodeURIComponent(stateAbbr)}&type=forecast&limit=500`;
    const listRes = await fetch(listUrl, { headers, cache: 'no-store' });
    if (!listRes.ok) {
      return { state: stateAbbr, kind: 'zone', upserted: 0, failed: 0, error: `zones list ${listRes.status}` };
    }
    const list = (await listRes.json()) as { features?: { properties?: { id?: string; code?: string } }[] };
    zoneIds = (list.features ?? [])
      .map((f) => f.properties?.id ?? f.properties?.code ?? '')
      .filter(Boolean);
  } catch (e) {
    return { state: stateAbbr, kind: 'zone', upserted: 0, failed: 0, error: e instanceof Error ? e.message : String(e) };
  }

  let cursor = 0;
  let upserted = 0;
  let failed = 0;
  async function worker() {
    while (cursor < zoneIds.length) {
      const ugc = zoneIds[cursor++];
      try {
        const r = await fetch(
          `https://api.weather.gov/zones/forecast/${encodeURIComponent(ugc)}`,
          { headers, cache: 'no-store' },
        );
        if (!r.ok) {
          failed++;
          continue;
        }
        const feat = (await r.json()) as { geometry?: GeoJSON.Geometry; properties?: { name?: string } };
        if (!feat.geometry) continue;
        const baseName = feat.properties?.name ?? ugc;
        await upsert({
          name: `${baseName} (${stateAbbr})`,
          kind: 'zone',
          county_fips: null,
          ugc_code: ugc,
          geojson: JSON.stringify(feat.geometry),
        });
        upserted++;
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: pool }, worker));
  return { state: stateAbbr, kind: 'zone', upserted, failed };
}

function stateInputToFips(s: string): string | null {
  const t = s.trim();
  if (/^\d{1,2}$/.test(t)) return t.padStart(2, '0');
  const abbr = t.toUpperCase();
  return ABBR_TO_FIPS[abbr] ?? null;
}
