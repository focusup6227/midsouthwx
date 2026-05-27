// F7: Latest SPC Day 1 / Day 2 / Day 3 categorical outlooks for the
// /radar map. Returns one entry per stored day with the FeatureCollection
// plus the summary fields (issued / valid / highest_label) that the
// inspector renders.
//
// SPC's own GeoJSON is global (CORS-open and stable), but going through
// our table means the radar map can render even when spc.noaa.gov is slow
// and gives us a single source of truth for cron health monitoring.

import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type SpcRow = {
  day_number: number;
  geojson: GeoJSON.FeatureCollection;
  feature_count: number;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  forecaster: string | null;
  highest_label: string | null;
  fetched_at: string;
};

export async function GET() {
  const supa = supabaseServer();
  const { data, error } = await supa
    .from('spc_outlooks')
    .select('day_number, geojson, feature_count, issued_at, valid_from, valid_until, forecaster, highest_label, fetched_at')
    .in('day_number', [1, 2, 3])
    .order('day_number');

  if (error) {
    return NextResponse.json(
      { days: [], error: error.message },
      { status: 200 },
    );
  }

  return NextResponse.json(
    { days: (data ?? []) as SpcRow[] },
    { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' } },
  );
}
