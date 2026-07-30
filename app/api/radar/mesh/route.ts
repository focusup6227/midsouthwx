import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// MRMS MESH hail-swath overlay via the Fly.io renderer (which reads NOAA's
// public MRMS GRIB feed). Returns { image_url, bounds, valid_time }.

export async function GET(req: NextRequest) {
  const windowRaw = parseInt(req.nextUrl.searchParams.get('window') ?? '30', 10);
  const window = windowRaw === 60 || windowRaw === 120 ? windowRaw : 30;

  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: 'renderer_not_configured' }, { status: 503 });
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/mesh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ window_minutes: window }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json(
        { error: 'renderer_error', status: upstream.status, body: text.slice(0, 300) },
        { status: 502 },
      );
    }
    const data = await upstream.json();
    return NextResponse.json(data, {
      // MRMS updates ~every 2 min.
      headers: { 'Cache-Control': 's-maxage=90, max-age=60' },
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = msg.includes('timeout') || msg.includes('aborted') ? 'renderer_timeout' : 'renderer_unreachable';
    return NextResponse.json({ error: code, detail: msg }, { status: 502 });
  }
}
