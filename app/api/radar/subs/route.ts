import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supa = supabaseServer();
  const { data: rows } = await supa
    .from('subscribers')
    .select('id, display_name, zip, location')
    .eq('status', 'active')
    .not('location', 'is', null)
    .limit(2000);

  const features = (rows || [])
    .map((r: any) => {
      const loc = r.location;
      let geometry: any = null;
      if (loc && typeof loc === 'object' && loc.coordinates) {
        geometry = { type: 'Point', coordinates: loc.coordinates };
      }
      if (geometry) {
        return {
          type: 'Feature',
          geometry,
          properties: { id: r.id, name: r.display_name, zip: r.zip },
        };
      }
      return null;
    })
    .filter(Boolean);

  return NextResponse.json({ type: 'FeatureCollection', features });
}
