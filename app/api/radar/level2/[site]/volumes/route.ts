import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Recent Level II volumes for a site — the client's hi-res loop uses these
// keys to prefetch renders via /api/radar/level2/[site]?volume_key=…

import { NEXRAD_CODES } from '@/lib/radar/sites';

const ALLOWED_SITES = new Set(NEXRAD_CODES);

export async function GET(
  req: NextRequest,
  { params }: { params: { site: string } },
) {
  const site = (params.site || '').toUpperCase();
  if (!ALLOWED_SITES.has(site)) {
    return NextResponse.json({ error: `unknown site '${site}'` }, { status: 404 });
  }
  const window = Math.min(180, Math.max(10, parseInt(req.nextUrl.searchParams.get('window') ?? '45', 10) || 45));

  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: 'renderer_not_configured' }, { status: 503 });
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/volumes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ site, window_minutes: window }),
      signal: AbortSignal.timeout(20_000),
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
      // New volumes land every ~4-6 min; a 60 s edge hold is plenty.
      headers: { 'Cache-Control': 's-maxage=60, max-age=30' },
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = msg.includes('timeout') || msg.includes('aborted') ? 'renderer_timeout' : 'renderer_unreachable';
    return NextResponse.json({ error: code, detail: msg }, { status: 502 });
  }
}
