// Active subscriber-report clusters (≥2 same-hazard reports within 5 km / 10
// min) as a Point FeatureCollection for the radar map's pulsing-ring overlay.
// Backed by public.recent_storm_report_clusters(p_minutes); RLS-gated to
// operators via supabaseServer.

import { parseFeatureCollection } from '@/lib/radar/geojson-utils';
import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 240;

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

  const geojson = parseFeatureCollection<GeoJSON.Point>(data);

  return NextResponse.json(
    { geojson, minutes },
    { headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' } },
  );
}
