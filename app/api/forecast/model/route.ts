import { NextRequest, NextResponse } from 'next/server';
import { MODEL_CATALOG, modelField } from '@/lib/forecast/model-charts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// On-demand bridge to the Fly.io renderer's /render-model endpoint (see
// _renderer/model_render.py). Same shape as the radar level2 proxy: we hide the
// renderer URL + bearer token server-side and return a public Supabase Storage
// URL for the rendered PNG. The frontend's Models panel just swaps the
// image_url as the operator moves the forecast-hour slider.

type RendererModelResponse = {
  model: string;
  field: string;
  fhr: number;
  region: string;
  image_url: string;
  bounds: { west: number; east: number; south: number; north: number };
  valid_time: string | null;
  cycle: string | null;
  label: string | null;
  unit: string | null;
  source: string | null;
  cached: boolean;
  render_ms: number;
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const model = (sp.get('model') || 'gfs').toLowerCase();
  const field = (sp.get('field') || '').toLowerCase();
  const region = (sp.get('region') || 'midsouth').toLowerCase();
  const fhr = Math.max(0, Math.min(384, parseInt(sp.get('fhr') || '0', 10) || 0));
  const cycle = sp.get('cycle'); // optional "YYYYMMDDHH"

  const m = MODEL_CATALOG.models.find((x) => x.key === model);
  if (!m) {
    return NextResponse.json({ error: `unknown model '${model}'` }, { status: 400 });
  }
  if (!modelField(model, field)) {
    return NextResponse.json({ error: `field '${field}' unavailable for ${model}` }, { status: 400 });
  }
  if (!MODEL_CATALOG.regions.some((r) => r.key === region)) {
    return NextResponse.json({ error: `unknown region '${region}'` }, { status: 400 });
  }

  const base = process.env.RENDERER_BASE_URL;
  const token = process.env.RENDERER_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: 'renderer_not_configured' }, { status: 503 });
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/render-model`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, field, fhr, region, cycle: cycle || null, force: false }),
      // GRIB fetch from NOMADS + render is heavier than a radar scan; allow more
      // headroom than the 30 s radar proxy, but still bounded so a stalled
      // NOMADS pull can't pin a connection slot indefinitely.
      signal: AbortSignal.timeout(45_000),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json(
        { error: 'renderer_error', status: upstream.status, body: text.slice(0, 500) },
        { status: 502 },
      );
    }

    const data = (await upstream.json()) as RendererModelResponse;
    return NextResponse.json(data, {
      // A model field for a fixed (cycle, fhr) is immutable once rendered, so
      // the edge can hold it for the life of the cycle.
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
