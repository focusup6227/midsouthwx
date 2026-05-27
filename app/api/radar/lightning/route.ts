import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Proxies GOES-19 GLM (Geostationary Lightning Mapper) flashes from the Fly.io
// renderer, the same way app/api/radar/level2/[site]/route.ts proxies Level II
// renders. Hides RENDERER_BASE_URL + RENDERER_TOKEN from the browser. Client
// passes a viewport bbox; server returns flashes from the last ~2 min.

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

export async function GET(req: NextRequest) {
  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: 'renderer_not_configured' }, { status: 503 });
  }

  const bbox = req.nextUrl.searchParams.get('bbox') || '';
  const since = req.nextUrl.searchParams.get('since') || '';

  if (bbox) {
    const parts = bbox.split(',');
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(parseFloat(p)))) {
      return NextResponse.json({ error: 'bad_bbox' }, { status: 400 });
    }
  }
  if (since && !/^\d{10,16}$/.test(since)) {
    return NextResponse.json({ error: 'bad_since' }, { status: 400 });
  }

  const upstream = new URL(`${base.replace(/\/$/, '')}/glm/recent`);
  if (bbox) upstream.searchParams.set('bbox', bbox);
  if (since) upstream.searchParams.set('since', since);

  try {
    const r = await fetch(upstream.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      // GLM ingestion reads 1–12 small NetCDFs from S3, usually < 5 s once the
      // Fly machine is awake. Allow a generous window for cold starts.
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const body = await r.text();
      return NextResponse.json(
        { ...EMPTY_FC, error: 'renderer_error', status: r.status, body: body.slice(0, 500) },
        { status: 502 },
      );
    }
    const data = await r.json();
    return NextResponse.json(data, {
      // Client polls every ~15 s; 5 s edge cache absorbs jitter without staling
      // visibly. Lightning lifetime on screen is 2 min, so a few seconds of
      // staleness is invisible.
      headers: {
        'Cache-Control': 's-maxage=5, max-age=0, stale-while-revalidate=15',
      },
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = msg.includes('timeout') || msg.includes('aborted')
      ? 'renderer_timeout'
      : 'renderer_unreachable';
    return NextResponse.json(
      { ...EMPTY_FC, error: code, detail: msg },
      { status: 502 },
    );
  }
}
