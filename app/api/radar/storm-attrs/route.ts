import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// NEXRAD Level III storm attributes via Iowa State Mesonet: per-cell TVS /
// mesocyclone flags, hail probabilities, VIL, and cell motion — the radar
// algorithm's own second opinion next to our Level II couplet detector.
// Cell motion (drct/sknt) also feeds the SRM storm-motion autofill.
const IEM_URL = 'https://mesonet.agron.iastate.edu/geojson/nexrad_attr.geojson';

// Same Mid-South sites couplet-poll scans.
const SITES = new Set(['NQA', 'DGX', 'GWX', 'OHX', 'LZK', 'HTX', 'PAH', 'MRX']);

let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 2 * 60_000) {
    return NextResponse.json(cache.body, { headers: { 'Cache-Control': 'private, max-age=60' } });
  }
  try {
    const res = await fetch(IEM_URL, {
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ error: `iem ${res.status}` }, { status: 502 });
    const fc = (await res.json()) as GeoJSON.FeatureCollection;

    const features = (fc.features ?? []).filter((f) => {
      const site = String((f.properties as any)?.nexrad ?? '');
      // IEM uses 3-letter ids (NQA); accept 4-letter too just in case.
      return SITES.has(site) || SITES.has(site.slice(-3));
    });

    const body = { type: 'FeatureCollection', features, fetched_at: new Date().toISOString() };
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'iem_unreachable' }, { status: 502 });
  }
}
