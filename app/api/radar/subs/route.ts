import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Subscriber locations live in a PostGIS geography column; supabase-js
// surfaces it as WKB hex unless we explicitly call ST_AsGeoJSON. The RPC
// returns a ready-to-render FeatureCollection.
export async function GET() {
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('subscriber_locations_geojson');
  if (error) {
    return NextResponse.json(
      { type: 'FeatureCollection', features: [], error: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json(data ?? { type: 'FeatureCollection', features: [] });
}
