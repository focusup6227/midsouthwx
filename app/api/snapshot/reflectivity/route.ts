// Internal API the nws-dispatcher Edge Function POSTs to in order to produce
// a reflectivity-overlay PNG (LibreWxR mosaic + Mapbox basemap + polygon
// outline) on Vercel instead of the Fly renderer. Operator-composed alerts
// call renderReflectivitySnapshot directly from the server action so they
// skip the HTTP roundtrip.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { renderReflectivitySnapshot } from '@/lib/snapshot/reflectivity-render';

export const runtime = 'nodejs'; // sharp is a native dep — needs Node, not Edge
export const maxDuration = 30;   // typical run ~3-8 s; cap at 30 s for cold starts

const GeoJsonGeom = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.any(),
});

const Body = z.object({
  alert_id: z.string().min(1).max(128),
  event: z.string().min(1).max(128),
  polygon: GeoJsonGeom,
});

export async function POST(req: NextRequest) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    // Server misconfigured — never accept a "no auth required" code path.
    return NextResponse.json({ ok: false, error: 'server_misconfigured' }, { status: 500 });
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'bad_request', detail: String(e) }, { status: 400 });
  }

  const url = await renderReflectivitySnapshot({
    alertId: parsed.alert_id,
    geometry: parsed.polygon as Parameters<typeof renderReflectivitySnapshot>[0]['geometry'],
    event: parsed.event,
  });
  if (!url) return NextResponse.json({ ok: false, error: 'render_failed' }, { status: 502 });
  return NextResponse.json({ ok: true, url });
}
