// F12: Recent METAR surface observations inside the Mid-South AOR for the
// /radar map. Backed by NOAA's Aviation Weather Center API, which returns
// a clean GeoJSON FeatureCollection — no parsing of raw METAR text needed.
//
// AWC publishes the canonical surface obs feed (~10 min latency for routine
// reports, special reports as they're issued). One call returns hundreds of
// stations CONUS-wide; we bbox-filter server-side so the client gets a
// payload sized for Mid-South use (~120 stations).

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Same envelope used by the LSR / NWS storm reports radar queries — keep in
// sync if the AOR ever changes.
const MIDSOUTH_BBOX = {
  west: -93.5,
  south: 32.8,
  east: -82.0,
  north: 37.5,
} as const;

// AWC accepts a bbox via the `bbox=lat0,lon0,lat1,lon1` parameter (note the
// lat-first ordering, opposite of GeoJSON). `hours=1` gives us the most
// recent observation per station; some quiet rural sites only report hourly
// so 1 hour is the smallest window that covers them.
const AWC_URL = (() => {
  const u = new URL('https://aviationweather.gov/api/data/metar');
  u.searchParams.set('format', 'geojson');
  u.searchParams.set('hours', '1');
  u.searchParams.set(
    'bbox',
    `${MIDSOUTH_BBOX.south},${MIDSOUTH_BBOX.west},${MIDSOUTH_BBOX.north},${MIDSOUTH_BBOX.east}`,
  );
  return u.toString();
})();

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

type AwcProps = {
  // Subset of AWC properties we expose. There are ~30 fields per station;
  // the ones below are what the radar tooltip + station-plot symbol layer
  // actually consume. Anything else stays in `raw` for the click popover.
  icaoId?: string;
  obsTime?: string;
  temp?: number | null;        // °C
  dewp?: number | null;        // °C
  wdir?: number | null;        // degrees true, 0=N
  wspd?: number | null;        // knots
  wgst?: number | null;        // knots
  altim?: number | null;       // hPa (inHg in some legacy responses; AWC's
                               // geojson endpoint uses hPa)
  visib?: number | string | null;
  wxString?: string | null;    // present weather, e.g. "TSRA"
  rawOb?: string;
};

type AwcFeature = GeoJSON.Feature<GeoJSON.Point, AwcProps & Record<string, unknown>>;

function trimProps(p: Record<string, unknown>): Record<string, unknown> {
  // Drop fields we don't use to keep the wire payload small. Kept list
  // mirrors the AwcProps subset above plus a `raw` blob for click details.
  const keys = [
    'icaoId', 'obsTime', 'temp', 'dewp', 'wdir', 'wspd', 'wgst',
    'altim', 'visib', 'wxString', 'rawOb', 'name',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in p) out[k] = p[k];
  }
  return out;
}

export async function GET() {
  const ua = process.env.NWS_USER_AGENT
    || 'midsouthwx (contact: operator@midsouthwx)';

  try {
    const res = await fetch(AWC_URL, {
      headers: {
        // AWC's API does honor a User-Agent like the NWS API does, even if
        // less strictly. Reuse the existing NWS_USER_AGENT secret so the
        // contact email lives in one place.
        'User-Agent': ua,
        Accept: 'application/geo+json, application/json',
      },
      // 10 s is comfortable for a CONUS bbox query; AWC typically responds
      // in 1-2 s. Anything longer probably means the endpoint is degraded
      // and stale obs are still better than nothing.
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { geojson: EMPTY_FC, error: `awc_${res.status}` },
        { status: 200 },
      );
    }

    const data = (await res.json()) as GeoJSON.FeatureCollection<GeoJSON.Point, AwcProps>;
    const features: AwcFeature[] = (data.features ?? []).map((f) => ({
      ...f,
      properties: trimProps(f.properties as unknown as Record<string, unknown>) as AwcProps,
    }));

    return NextResponse.json(
      { geojson: { type: 'FeatureCollection', features }, count: features.length },
      {
        headers: {
          // AWC publishes ~every 10 min; 2-min edge cache eats jitter
          // without staling the display.
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
