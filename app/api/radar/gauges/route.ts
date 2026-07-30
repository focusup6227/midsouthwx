import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// NOAA NWPS river gauges for the Mid-South service area: observed stage +
// flood category + forecast crest where available. 5-min server cache — the
// upstream updates on 15-60 min cadences.
const NWPS_URL =
  'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-95&bbox.ymin=31&bbox.xmax=-82&bbox.ymax=38.5&srid=EPSG_4326';

type NwpsGauge = {
  lid?: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  status?: {
    observed?: { primary?: number; primaryUnit?: string; floodCategory?: string; validTime?: string };
    forecast?: { primary?: number; primaryUnit?: string; floodCategory?: string; validTime?: string };
  };
  flood?: { categories?: Record<string, { stage?: number }> };
};

let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 5 * 60_000) {
    return NextResponse.json(cache.body, { headers: { 'Cache-Control': 'private, max-age=120' } });
  }
  try {
    const res = await fetch(NWPS_URL, {
      headers: { 'User-Agent': process.env.NWS_USER_AGENT ?? 'midsouthwx' },
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ error: `nwps ${res.status}` }, { status: 502 });
    const data = (await res.json()) as { gauges?: NwpsGauge[] };

    const features = (data.gauges ?? [])
      .filter((g) => Number.isFinite(g.latitude) && Number.isFinite(g.longitude))
      .map((g) => {
        const obs = g.status?.observed;
        const fct = g.status?.forecast;
        return {
          type: 'Feature' as const,
          id: g.lid,
          geometry: { type: 'Point' as const, coordinates: [g.longitude!, g.latitude!] },
          properties: {
            lid: g.lid ?? '',
            name: g.name ?? '',
            observed: obs?.primary ?? null,
            observed_unit: obs?.primaryUnit ?? 'ft',
            observed_at: obs?.validTime ?? null,
            // NWPS categories: no_flooding | action | minor | moderate | major
            category: (obs?.floodCategory ?? 'no_flooding').toLowerCase(),
            forecast: fct?.primary ?? null,
            forecast_category: (fct?.floodCategory ?? '').toLowerCase() || null,
            forecast_at: fct?.validTime ?? null,
          },
        };
      });

    const body = { type: 'FeatureCollection', features, fetched_at: new Date().toISOString() };
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=120' } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'nwps_unreachable' }, { status: 502 });
  }
}
