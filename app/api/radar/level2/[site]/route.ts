import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// On-demand bridge to the Fly.io renderer (../midsouthwx-radar-renderer).
// We hide the renderer URL + bearer token from the browser by proxying server-
// side. The frontend just hits this route with { site, product } and gets back
// a public Supabase Storage URL for the rendered PNG plus its lat/lon bounds.

const ALLOWED_PRODUCTS = new Set(['refl', 'vel', 'cc']);
const ALLOWED_FORMATS = new Set(['png', 'geojson']);

const ALLOWED_SITES = new Set([
  'KNQA', 'KGWX', 'KMRX', 'KOHX', 'KHTX', 'KLZK', 'KFFC', 'KTLH',
]);

type SweepInfo = { index: number; elevation_deg: number };

type RendererResponse = {
  site: string;
  product: 'refl' | 'vel' | 'cc';
  scan_time: string;
  image_url?: string | null;
  geojson_url?: string | null;
  bounds: { north: number; south: number; east: number; west: number };
  cached: boolean;
  render_ms: number;
  available_sweeps?: SweepInfo[];
  sweep_index?: number | null;
  feature_count?: number | null;
  vmin?: number | null;
  vmax?: number | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: { site: string } },
) {
  const site = (params.site || '').toUpperCase();
  const product = (req.nextUrl.searchParams.get('product') || 'refl').toLowerCase();
  const composite = req.nextUrl.searchParams.get('composite') === '1';
  const format = (req.nextUrl.searchParams.get('format') || 'png').toLowerCase();
  const sweepIndexRaw = req.nextUrl.searchParams.get('sweep_index');
  const sweepIndex = sweepIndexRaw != null ? Math.max(0, parseInt(sweepIndexRaw, 10) || 0) : 0;

  if (!ALLOWED_SITES.has(site)) {
    return NextResponse.json({ error: `unknown site '${site}'` }, { status: 404 });
  }
  if (!ALLOWED_PRODUCTS.has(product)) {
    return NextResponse.json({ error: `unsupported product '${product}'` }, { status: 400 });
  }
  if (!ALLOWED_FORMATS.has(format)) {
    return NextResponse.json({ error: `unsupported format '${format}'` }, { status: 400 });
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
      body: JSON.stringify({
        site,
        product,
        force: false,
        composite,
        format,
        sweep_index: sweepIndex,
      }),
      // Cold starts on Fly + render can take 30–90 s on first hit.
      // Use a generous timeout so we don't 502 the user during wake-up.
      signal: AbortSignal.timeout(120_000),
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
    const msg = e?.message || String(e);
    // Distinguish timeout so the UI can show a clearer message
    const code = msg.includes('timeout') || msg.includes('aborted') ? 'renderer_timeout' : 'renderer_unreachable';
    return NextResponse.json(
      { error: code, detail: msg },
      { status: 502 },
    );
  }
}
