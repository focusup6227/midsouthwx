import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Proxy to the renderer's /render-obs-sounding (observed RAOB → MetPy Skew-T).
// Same shape as the forecast-sounding proxy; the renderer walks back 00Z/12Z to
// the latest posted release for the station.

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const wmo = (sp.get('wmo') || '').trim();
  const name = (sp.get('name') || '').trim();
  if (!/^\d{4,5}$/.test(wmo)) {
    return NextResponse.json({ error: 'valid wmo required' }, { status: 400 });
  }

  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: 'renderer_not_configured' }, { status: 503 });
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/render-obs-sounding`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wmo, name, force: false }),
      signal: AbortSignal.timeout(45_000),
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
      headers: {
        'Cache-Control': 's-maxage=3600, max-age=600, stale-while-revalidate=7200',
        'CDN-Cache-Control': 'public, s-maxage=3600',
      },
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = msg.includes('timeout') || msg.includes('aborted') ? 'renderer_timeout' : 'renderer_unreachable';
    return NextResponse.json({ error: code }, { status: 502 });
  }
}
