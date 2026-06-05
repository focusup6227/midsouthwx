import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Proxy to the renderer's /render-sounding (GFS/NAM column → MetPy Skew-T PNG).
// Mirrors the model-chart proxy: hides the renderer URL/token, returns a public
// Supabase Storage image URL the panel shows as a plain <img>.

const ALLOWED_MODELS = new Set(['gfs', 'nam']);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const model = (sp.get('model') || 'gfs').toLowerCase();
  const lat = Number(sp.get('lat'));
  const lon = Number(sp.get('lon'));
  const fhr = Math.max(0, Math.min(84, parseInt(sp.get('fhr') || '0', 10) || 0));
  const cycle = sp.get('cycle');

  if (!ALLOWED_MODELS.has(model)) {
    return NextResponse.json({ error: `unknown model '${model}'` }, { status: 400 });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: 'lat and lon required' }, { status: 400 });
  }

  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: 'renderer_not_configured' }, { status: 503 });
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/render-sounding`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, lat, lon, fhr, cycle: cycle || null, force: false }),
      // Sounding pulls a full column + MetPy parcel calc; allow generous headroom.
      signal: AbortSignal.timeout(50_000),
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json(
        { error: 'renderer_error', status: upstream.status, body: text.slice(0, 500) },
        { status: 502 },
      );
    }
    const data = await upstream.json();
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 's-maxage=1800, max-age=300, stale-while-revalidate=3600',
        'CDN-Cache-Control': 'public, s-maxage=1800',
      },
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = msg.includes('timeout') || msg.includes('aborted') ? 'renderer_timeout' : 'renderer_unreachable';
    return NextResponse.json({ error: code, detail: msg }, { status: 502 });
  }
}
