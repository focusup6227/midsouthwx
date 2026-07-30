import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// TDOT SmartWay roadway incidents/closures — same open-data API (and key)
// as the traffic-cams layer. Flooded/blocked roads are ground truth the
// operator can pass along in alerts and all-clears.
const TDOT_URL = 'https://www.tdot.tn.gov/opendata/api/public/RoadwayIncidents';
const TDOT_PUBLIC_KEY = '8d3b7a82635d476795c09b2c41facc60';

type TdotIncident = {
  id: number;
  description?: string;
  eventTypeName?: string;
  eventSubTypeDescription?: string;
  impactDescription?: string;
  directionDescription?: string;
  hasClosure?: boolean;
  isSevere?: boolean;
  beginningDate?: string;
  locations?: { midPoint?: { lat?: number; lng?: number }; countyName?: string }[];
};

let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 2 * 60_000) {
    return NextResponse.json(cache.body, { headers: { 'Cache-Control': 'private, max-age=60' } });
  }
  try {
    const res = await fetch(TDOT_URL, {
      headers: { ApiKey: process.env.TDOT_API_KEY ?? TDOT_PUBLIC_KEY },
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ error: `TDOT ${res.status}` }, { status: 502 });
    const rows = (await res.json()) as TdotIncident[];

    const features = (Array.isArray(rows) ? rows : [])
      .map((r) => {
        const mid = r.locations?.[0]?.midPoint;
        if (!mid || !Number.isFinite(mid.lat) || !Number.isFinite(mid.lng)) return null;
        return {
          type: 'Feature' as const,
          id: r.id,
          geometry: { type: 'Point' as const, coordinates: [mid.lng!, mid.lat!] },
          properties: {
            id: r.id,
            type: r.eventSubTypeDescription || r.eventTypeName || 'Incident',
            description: (r.description ?? '').slice(0, 400),
            impact: r.impactDescription ?? null,
            direction: r.directionDescription ?? null,
            county: r.locations?.[0]?.countyName ?? null,
            closure: Boolean(r.hasClosure),
            severe: Boolean(r.isSevere),
            began_at: r.beginningDate ?? null,
          },
        };
      })
      .filter(Boolean);

    const body = { type: 'FeatureCollection', features, fetched_at: new Date().toISOString() };
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'tdot_unreachable' }, { status: 502 });
  }
}
