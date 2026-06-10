// ProbSevere 3.0 — NOAA/CIMSS object-based, machine-learning severe-weather
// guidance. Every ~2 min it emits a GeoJSON FeatureCollection of storm
// objects, each tagged with calibrated probabilities of becoming severe in the
// next 60 min: ProbSevere (any severe), ProbTor (tornado), ProbHail, ProbWind.
// It's the modern nowcasting decision aid — "this cell is 78% ProbTor" — and
// fuses radar (MESH/VIL/azshear), satellite, lightning (ENI flash rate), and
// NWP (MUCAPE/EBSHEAR/SRH) into one number per storm.
//
// The feed lives at mrms.ncep.noaa.gov as timestamped files in a directory
// listing. The browser can't fetch it (no CORS + we'd re-download the listing
// per client); we resolve the latest file server-side, slim the properties to
// what the radar UI renders, and hand back clean GeoJSON. Cached 60 s — well
// under the ~2-min production cadence.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

const DIR = 'https://mrms.ncep.noaa.gov/ProbSevere/PROBSEVERE/';
const FILE_RE = /MRMS_PROBSEVERE_(\d{8}_\d{6})\.json/g;

// Properties we surface in the UI. ProbSevere ships ~50 fields per object;
// keeping a focused set cuts the payload and keeps the inspector readable.
const KEEP_NUMERIC = [
  'ProbSevere', 'ProbTor', 'ProbHail', 'ProbWind',
  'MUCAPE', 'MLCAPE', 'MLCIN', 'EBSHEAR', 'SRH01KM',
  'MESH', 'VIL', 'COMPREF', 'EchoTop_50', 'FLASH_RATE',
  'MOTION_EAST', 'MOTION_SOUTH',
] as const;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

// mrms.ncep.noaa.gov intermittently 503s a single request under load. One blip
// would otherwise blank the overlay until SWR's next 120 s refresh, so retry a
// couple times with a short backoff before giving up.
async function fetchRetry(url: string, tries = 3): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        next: { revalidate: 60 },
        // Fresh signal per attempt so one hung connection can't eat the whole
        // retry budget.
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return res;
      last = res;
    } catch (err) {
      // Timeout / network error counts as a failed attempt. Rethrow on the
      // final try so GET's catch returns the standard empty-FC error shape.
      if (i === tries - 1) throw err;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return last as Response;
}

type PSFeature = {
  type: 'Feature';
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  properties: Record<string, unknown> & { models?: { probsevere?: Record<string, string> } };
};

export async function GET() {
  try {
    // 1. Resolve the newest MRMS_PROBSEVERE_<ts>.json from the directory listing.
    const listRes = await fetchRetry(DIR);
    if (!listRes.ok) {
      return NextResponse.json(
        { type: 'FeatureCollection', features: [], error: `listing_${listRes.status}` },
        { status: 502 },
      );
    }
    const html = await listRes.text();
    let latest: string | null = null;
    for (const m of html.matchAll(FILE_RE)) {
      if (!latest || m[1] > latest) latest = m[1]; // YYYYMMDD_HHMMSS sorts lexically
    }
    if (!latest) {
      return NextResponse.json(
        { type: 'FeatureCollection', features: [], error: 'no_file' },
        { status: 502 },
      );
    }

    // 2. Fetch that timestamped file.
    const fileUrl = `${DIR}MRMS_PROBSEVERE_${latest}.json`;
    const dataRes = await fetchRetry(fileUrl);
    if (!dataRes.ok) {
      return NextResponse.json(
        { type: 'FeatureCollection', features: [], error: `file_${dataRes.status}` },
        { status: 502 },
      );
    }
    const raw = (await dataRes.json()) as { features?: PSFeature[]; validTime?: string };

    // 3. Normalize: parse string probs/params to numbers, attach a readout, drop
    //    the rest. Compute a `topProb` + `topType` so the map can color by the
    //    dominant hazard at a glance.
    const features = (raw.features ?? []).map((f) => {
      const src = f.properties ?? {};
      const props: Record<string, number | string> = {};
      for (const k of KEEP_NUMERIC) props[k] = num(src[k]);

      const probs: Array<[string, number]> = [
        ['severe', num(src.ProbSevere)],
        ['tor', num(src.ProbTor)],
        ['hail', num(src.ProbHail)],
        ['wind', num(src.ProbWind)],
      ];
      const top = probs.reduce((a, b) => (b[1] > a[1] ? b : a));
      props.topType = top[0];
      props.topProb = top[1];
      props.ID = String(src.ID ?? '');

      // Pre-formatted multi-line human readout (LINE01..LINEnn) for the tooltip.
      const lines = f.properties?.models?.probsevere ?? {};
      props.readout = Object.keys(lines)
        .filter((k) => /^LINE\d+$/.test(k))
        .sort()
        .map((k) => lines[k])
        .join('\n');

      return { type: 'Feature' as const, geometry: f.geometry, properties: props };
    });

    return NextResponse.json(
      {
        type: 'FeatureCollection',
        features,
        validTime: raw.validTime ?? latest,
        fetchedAt: Date.now(),
      },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } },
    );
  } catch (err) {
    return NextResponse.json(
      { type: 'FeatureCollection', features: [], error: String(err) },
      { status: 502 },
    );
  }
}
