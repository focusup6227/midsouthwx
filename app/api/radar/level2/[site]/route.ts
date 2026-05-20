import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// On-demand bridge to the Fly.io renderer (../midsouthwx-radar-renderer).
// We hide the renderer URL + bearer token from the browser by proxying server-
// side. The frontend just hits this route with { site, product } and gets back
// a public Supabase Storage URL for the rendered PNG plus its lat/lon bounds.

const ALLOWED_PRODUCTS = new Set(['refl', 'vel']);

const ALLOWED_SITES = new Set([
  'KNQA', 'KGWX', 'KMRX', 'KOHX', 'KHTX', 'KLZK', 'KFFC', 'KTLH',
]);

type RendererResponse = {
  site: string;
  product: 'refl' | 'vel';
  scan_time: string;
  image_url: string;
  bounds: { north: number; south: number; east: number; west: number };
  cached: boolean;
  render_ms: number;
};

export async function GET(
  req: NextRequest,
  { params }: { params: { site: string } },
) {
  const site = (params.site || '').toUpperCase();
  const product = (req.nextUrl.searchParams.get('product') || 'refl').toLowerCase();

  if (!ALLOWED_SITES.has(site)) {
    return NextResponse.json({ error: `unknown site '${site}'` }, { status: 404 });
  }
  if (!ALLOWED_PRODUCTS.has(product)) {
    return NextResponse.json({ error: `unsupported product '${product}'` }, { status: 400 });
  }

  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: 'renderer_not_configured' },
      { status: 503 },
    );
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/render`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ site, product, force: false }),
      // Cold starts on Fly can take ~5-9s; rendering itself is up to a few
      // seconds; cache hits are <1s. 30s timeout swallows the worst case.
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json(
        { error: 'renderer_error', status: upstream.status, body: text.slice(0, 500) },
        { status: 502 },
      );
    }

    const data = (await upstream.json()) as RendererResponse;
    return NextResponse.json(data, {
      // Browser cache: 60s. Cache key is the URL (which includes ?product=).
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'renderer_unreachable', detail: e?.message || String(e) },
      { status: 502 },
    );
  }
}
