// F4: Recent NWS Local Storm Reports (last ~6h) inside the mid-south AOR,
// as a GeoJSON FeatureCollection for the /radar map layer.
//
// Backed by the public.nws_storm_reports_geojson(hours) SQL function which
// applies the AOR envelope filter + time window in one round-trip.

import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DEFAULT_HOURS = 6;
const MAX_HOURS = 24;

type Geometry = GeoJSON.Point;

function parseFeatureCollection(raw: unknown): GeoJSON.FeatureCollection<Geometry> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { type?: string; features?: unknown[] };
  if (o.type !== 'FeatureCollection' || !Array.isArray(o.features)) return null;
  return o as GeoJSON.FeatureCollection<Geometry>;
}

export async function GET(req: Request) {
  const supa = supabaseServer();
  const url = new URL(req.url);
  const hoursParam = parseInt(url.searchParams.get('hours') ?? '', 10);
  const hours = Number.isFinite(hoursParam)
    ? Math.max(1, Math.min(MAX_HOURS, hoursParam))
    : DEFAULT_HOURS;

  const { data, error } = await supa.rpc('nws_storm_reports_geojson', { p_hours: hours });

  if (error) {
    return NextResponse.json(
      { geojson: { type: 'FeatureCollection', features: [] }, error: error.message },
      { status: 200 },
    );
  }

  const geojson = parseFeatureCollection(data) ?? {
    type: 'FeatureCollection' as const,
    features: [],
  };

  return NextResponse.json(
    { geojson, hours },
    { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } },
  );
}
