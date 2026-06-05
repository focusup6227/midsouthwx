import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Read-side proxy to the renderer's /sample-point (HRRR CAPE/CIN/SRH/shear at a
// point). The AI draft already consumes these server-side; this exposes the
// same numbers to the operator's Severe-ingredients panel.

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const lat = Number(sp.get('lat'));
  const lon = Number(sp.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: 'lat and lon required' }, { status: 400 });
  }

  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: 'renderer_not_configured' }, { status: 503 });
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/sample-point`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, fhr: 0 }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json({ error: 'renderer_error', status: upstream.status, body: text.slice(0, 300) }, { status: 502 });
    }
    const data = await upstream.json();
    return NextResponse.json(data, {
      // HRRR analysis updates hourly; a few minutes of edge cache is plenty.
      headers: { 'Cache-Control': 's-maxage=600, max-age=120, stale-while-revalidate=1800' },
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = msg.includes('timeout') || msg.includes('aborted') ? 'renderer_timeout' : 'renderer_unreachable';
    return NextResponse.json({ error: code }, { status: 502 });
  }
}
