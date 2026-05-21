import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('regions_map_geojson');
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data ?? { type: 'FeatureCollection', features: [] });
}
