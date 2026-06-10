// Recent subscriber-submitted storm reports (Telegram /report flow) inside
// the mid-south AOR, as a GeoJSON FeatureCollection for the /radar map layer.
// Backed by public.telegram_storm_reports_geojson(hours); RLS gates it to
// operators via supabaseServer.

import { parseFeatureCollection } from '@/lib/radar/geojson-utils';
import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DEFAULT_HOURS = 24;
const MAX_HOURS = 168; // 7 days

export async function GET(req: Request) {
  const supa = supabaseServer();
  const url = new URL(req.url);
  const hoursParam = parseInt(url.searchParams.get('hours') ?? '', 10);
  const hours = Number.isFinite(hoursParam)
    ? Math.max(1, Math.min(MAX_HOURS, hoursParam))
    : DEFAULT_HOURS;

  const { data, error } = await supa.rpc('telegram_storm_reports_geojson', { p_hours: hours });

  if (error) {
    return NextResponse.json(
      { geojson: { type: 'FeatureCollection', features: [] }, error: error.message },
      { status: 200 },
    );
  }

  const geojson = parseFeatureCollection<GeoJSON.Point>(data);

  return NextResponse.json(
    { geojson, hours },
    { headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' } },
  );
}
