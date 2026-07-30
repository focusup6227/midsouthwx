import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// WPC Excessive Rainfall Outlook Day 1 via the renderer (which parses WPC's
// shapefile zip). Returns { geojson_url, valid_date } — the client fetches
// the gzipped GeoJSON straight from storage.
export async function GET() {
  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: 'renderer_not_configured' }, { status: 503 });
  }
  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/ero`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json(
        { error: 'renderer_error', status: upstream.status, body: text.slice(0, 200) },
        { status: 502 },
      );
    }
    const data = await upstream.json();
    return NextResponse.json(data, {
      // New ERO issuances land a few times daily.
      headers: { 'Cache-Control': 's-maxage=900, max-age=600' },
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    return NextResponse.json(
      { error: msg.includes('timeout') ? 'renderer_timeout' : 'renderer_unreachable' },
      { status: 502 },
    );
  }
}
