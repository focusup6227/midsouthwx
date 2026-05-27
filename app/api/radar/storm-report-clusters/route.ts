// Active subscriber-report clusters (≥2 same-hazard reports within 5 km / 10
// min) as a Point FeatureCollection for the radar map's pulsing-ring overlay.
// Backed by public.recent_storm_report_clusters(p_minutes); RLS-gated to
// operators via supabaseServer.

import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 240;

type Geometry = GeoJSON.Point;

function parseFC(raw: unknown): GeoJSON.FeatureCollection<Geometry> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { type?: string; features?: unknown[] };
  if (o.type !== 'FeatureCollection' || !Array.isArray(o.features)) return null;
  return o as GeoJSON.FeatureCollection<Geometry>;
}

export async function GET(req: Request) {
  const supa = supabaseServer();
  const url = new URL(req.url);
  const mp = parseInt(url.searchParams.get('minutes') ?? '', 10);
  const minutes = Number.isFinite(mp)
    ? Math.max(1, Math.min(MAX_MINUTES, mp))
    : DEFAULT_MINUTES;

  const { data, error } = await supa.rpc('recent_storm_report_clusters', { p_minutes: minutes });
  if (error) {
    return NextResponse.json(
      { geojson: { type: 'FeatureCollection', features: [] }, error: error.message },
      { status: 200 },
    );
  }

  const geojson = parseFC(data) ?? {
    type: 'FeatureCollection' as const,
    features: [],
  };

  return NextResponse.json(
    { geojson, minutes },
    { headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' } },
  );
}
