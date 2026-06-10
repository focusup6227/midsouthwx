// TDOT SmartWay traffic cameras for the /radar map — live ground truth
// ("what does it actually look like under that storm") along Tennessee
// interstates. 667 cameras statewide, ~140 in the Memphis jurisdiction.
//
// Source: TDOT's open-data API (https://www.tdot.tn.gov/opendata/api/public/)
// — the same feed smartway.tn.gov itself uses; the API key ships in that
// site's public runtime config (config/config.prod.json), so it is a public
// key, not a credential we own. It can still rotate without notice, so the
// failure mode is an empty FeatureCollection + 200: the layer just goes
// quiet, the radar never breaks. Override via TDOT_API_KEY if they ever
// publish a new one.
//
// Camera positions are static, so we hold a 10-min in-memory cache and let
// the client refresh snapshots (tnsnapshots.com PNGs) directly per camera.
// Arkansas is deliberately absent: iDriveArkansas' camera terms prohibit
// third-party embedding.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const TDOT_URL = 'https://www.tdot.tn.gov/opendata/api/public/RoadwayCameras';
const TDOT_PUBLIC_KEY = '8d3b7a82635d476795c09b2c41facc60';

type TdotCamera = {
  id: number;
  title?: string;
  route?: string;
  mileMarker?: string;
  jurisdiction?: string;
  lat?: number;
  lng?: number;
  active?: string;
  thumbnailUrl?: string;
  httpsVideoUrl?: string;
};

type CacheEntry = { at: number; body: unknown };
let cache: CacheEntry | null = null;
const CACHE_MS = 10 * 60_000;

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.body, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  }

  try {
    const res = await fetch(TDOT_URL, {
      headers: { ApiKey: process.env.TDOT_API_KEY ?? TDOT_PUBLIC_KEY },
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`[traffic-cams] TDOT HTTP ${res.status}`);
      return NextResponse.json({ geojson: EMPTY, error: `TDOT ${res.status}` });
    }
    const cams = (await res.json()) as TdotCamera[];

    const features = cams
      .filter(
        (c) =>
          c.active?.toLowerCase() === 'true' &&
          typeof c.lat === 'number' &&
          typeof c.lng === 'number' &&
          !!c.thumbnailUrl,
      )
      .map((c) => ({
        type: 'Feature' as const,
        id: c.id,
        geometry: { type: 'Point' as const, coordinates: [c.lng!, c.lat!] },
        properties: {
          id: c.id,
          title: c.title ?? 'Camera',
          route: c.route ?? null,
          mile_marker: c.mileMarker ?? null,
          jurisdiction: c.jurisdiction ?? null,
          thumbnail_url: c.thumbnailUrl ?? null,
          video_url: c.httpsVideoUrl ?? null,
        },
      }));

    const body = {
      geojson: { type: 'FeatureCollection' as const, features },
      count: features.length,
      fetched_at: new Date().toISOString(),
    };
    cache = { at: Date.now(), body };
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  } catch (e) {
    console.error('[traffic-cams]', e);
    return NextResponse.json({ geojson: EMPTY, error: String(e) });
  }
}
