// F13: mPING crowdsource ground-truth reports for the /radar map. NSSL's
// public reports API returns recent user-submitted observations of hail,
// wind damage, snow, etc. Lower confidence than NWS LSRs (which are vetted
// by a forecaster) but much faster — citizens often ping before the
// official LSR pipeline catches up.
//
// We hit https://mping.nssl.ou.edu/api/v2/reports/ unauthenticated. The
// endpoint is open but rate-limited; we cap our poll cadence at 2 min
// (client SWR refresh) and add a 2-min edge cache so concurrent operator
// loads de-dup.
//
// Failure mode: empty FeatureCollection + 200 OK. mPING uptime is variable;
// the operator's situational picture should never crash on it.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MIDSOUTH_BBOX = {
  west: -93.5,
  south: 32.8,
  east: -82.0,
  north: 37.5,
} as const;

const LOOKBACK_HOURS = 3;

type MpingReport = {
  id: number;
  obtime: string;            // ISO timestamp
  category: number;          // numeric category id
  description: string;       // human-readable category, e.g. "Hail 1.00 in"
  description_id?: number | null;
  geom: { type: 'Point'; coordinates: [number, number] };
};

type MpingResponse = { results?: MpingReport[]; count?: number };

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

// Map mPING free-text descriptions to our standard radar hazard kinds so
// the pins color-code consistently with NWS warnings + LSRs. Conservative:
// only buckets we recognize get a hazard; unknown ones fall through to
// 'other' and render in neutral.
function classifyMping(description: string): 'tornado' | 'severe' | 'flood' | 'wind' | 'winter' | 'other' {
  const d = description.toLowerCase();
  if (d.includes('tornado') || d.includes('funnel') || d.includes('wall cloud')) return 'tornado';
  if (d.includes('hail')) return 'severe';
  if (d.includes('flood')) return 'flood';
  if (d.includes('wind') || d.includes('damage')) return 'wind';
  if (d.includes('snow') || d.includes('ice') || d.includes('sleet') || d.includes('graupel') || d.includes('freezing')) return 'winter';
  return 'other';
}

function inBbox(lon: number, lat: number): boolean {
  return (
    lon >= MIDSOUTH_BBOX.west &&
    lon <= MIDSOUTH_BBOX.east &&
    lat >= MIDSOUTH_BBOX.south &&
    lat <= MIDSOUTH_BBOX.north
  );
}

export async function GET() {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');

  const url = new URL('https://mping.nssl.ou.edu/api/v2/reports/');
  url.searchParams.set('obtime_gte', since);
  // mPING's bbox filter is lon0,lat0,lon1,lat1 (W,S,E,N).
  url.searchParams.set(
    'bbox',
    `${MIDSOUTH_BBOX.west},${MIDSOUTH_BBOX.south},${MIDSOUTH_BBOX.east},${MIDSOUTH_BBOX.north}`,
  );
  url.searchParams.set('page_size', '500');

  const ua = process.env.NWS_USER_AGENT || 'midsouthwx (contact: operator@midsouthwx)';

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': ua, Accept: 'application/json' },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { geojson: EMPTY_FC, error: `mping_${res.status}` },
        { status: 200 },
      );
    }
    const data = (await res.json()) as MpingResponse;
    const reports = data.results ?? [];

    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const r of reports) {
      const coords = r.geom?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const [lon, lat] = coords;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      // mPING's bbox filter is server-side, but worth a defensive re-check
      // since the API sometimes returns stragglers outside the requested
      // window when reports come in late.
      if (!inBbox(lon, lat)) continue;
      features.push({
        type: 'Feature',
        id: r.id,
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          id: r.id,
          description: r.description,
          hazard: classifyMping(r.description),
          obtime: r.obtime,
          category: r.category,
        },
      });
    }

    return NextResponse.json(
      {
        geojson: { type: 'FeatureCollection', features },
        count: features.length,
        hours: LOOKBACK_HOURS,
      },
      {
        headers: {
          // mPING reports trickle in continuously; 2-min cache is a
          // reasonable trade between freshness and load.
          'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300',
        },
      },
    );
  } catch (e: any) {
    return NextResponse.json(
      { geojson: EMPTY_FC, error: e?.message || 'fetch_error' },
      { status: 200 },
    );
  }
}
