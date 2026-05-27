// Stage 3b: GeoJSON feed for the /radar CAP overlay. Mirrors
// /api/radar/warnings but reads cap_alerts (LibreWxR pipeline). No storm
// tracks / forecast corridors — LibreWxR doesn't provide motion data.

import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type Geom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

function parseFeatureCollection(raw: unknown): GeoJSON.FeatureCollection<Geom> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { type?: string; features?: unknown[] };
  if (o.type !== 'FeatureCollection' || !Array.isArray(o.features)) return null;
  return o as GeoJSON.FeatureCollection<Geom>;
}

export async function GET() {
  const supa = supabaseServer();

  const { data: fcRaw, error } = await supa.rpc('cap_alerts_radar_geojson');

  if (error) {
    return NextResponse.json(
      {
        geojson: { type: 'FeatureCollection', features: [] },
        error: error.message,
      },
      { status: 200 },
    );
  }

  const geojson =
    parseFeatureCollection(fcRaw) ?? { type: 'FeatureCollection' as const, features: [] };

  return NextResponse.json(
    { geojson },
    { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } },
  );
}
