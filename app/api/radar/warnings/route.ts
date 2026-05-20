import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Mid-South-ish bbox: ~ AR / TN / MS / N AL / W KY. Used to drop coast-to-coast
// alerts that would clutter the radar page (the dispatcher still tracks them in
// nws_alerts; this endpoint is just for the radar overlay).
const MIDSOUTH_BBOX = { west: -93.5, south: 32.8, east: -82.0, north: 37.5 };

type Polygon = { type: 'Polygon'; coordinates: number[][][] };
type MultiPolygon = { type: 'MultiPolygon'; coordinates: number[][][][] };
type Geom = Polygon | MultiPolygon;

type WarningType = 'tornado' | 'severe' | 'flood' | 'other';

type WarningOut = {
  id: string;
  nws_id: string;
  type: WarningType;
  event: string;
  label: string;
  area_desc: string | null;
  expires_at: string | null;
  centroid: [number, number];
  geometry: Geom;
};

function classify(event: string): WarningType {
  const e = event.toLowerCase();
  if (e.includes('tornado')) return 'tornado';
  if (e.includes('severe thunderstorm')) return 'severe';
  if (e.includes('flood') || e.includes('flash flood')) return 'flood';
  return 'other';
}

function intersectsMidSouth(g: Geom): { intersects: boolean; centroid: [number, number] } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sumX = 0;
  let sumY = 0;
  let n = 0;

  const visit = (rings: number[][][]) => {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        sumX += x;
        sumY += y;
        n++;
      }
    }
  };

  if (g.type === 'Polygon') visit(g.coordinates);
  else for (const poly of g.coordinates) visit(poly);

  if (!n) return { intersects: false, centroid: [0, 0] };

  const intersects =
    !(maxX < MIDSOUTH_BBOX.west ||
      minX > MIDSOUTH_BBOX.east ||
      maxY < MIDSOUTH_BBOX.south ||
      minY > MIDSOUTH_BBOX.north);

  return { intersects, centroid: [sumX / n, sumY / n] };
}

function shortLocation(area_desc: string | null): string | null {
  if (!area_desc) return null;
  const counties = area_desc.split(/;|,/).map((s) => s.trim()).filter(Boolean);
  if (counties.length === 0) return null;
  if (counties.length === 1) return counties[0];
  if (counties.length === 2) return `${counties[0]} & ${counties[1]}`;
  return `${counties[0]} +${counties.length - 1}`;
}

export async function GET() {
  const supa = supabaseServer();

  const { data: rows, error } = await supa
    .from('nws_alerts')
    .select('id, nws_id, event, headline, area_desc, expires_at, status, polygon')
    .not('polygon', 'is', null)
    .in('status', ['new', 'dispatched'])
    .gt('expires_at', new Date().toISOString())
    .order('ingested_at', { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ warnings: [] as WarningOut[], error: error.message }, { status: 200 });
  }

  const warnings: WarningOut[] = [];
  for (const r of rows ?? []) {
    const geom = r.polygon as unknown as Geom | null;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
    const { intersects, centroid } = intersectsMidSouth(geom);
    if (!intersects) continue;

    const type = classify(r.event ?? '');
    const where = shortLocation(r.area_desc);
    const baseEvent = r.event ?? 'Alert';
    const label = where ? `${baseEvent} · ${where}` : baseEvent;

    warnings.push({
      id: r.id,
      nws_id: r.nws_id,
      type,
      event: baseEvent,
      label,
      area_desc: r.area_desc ?? null,
      expires_at: r.expires_at ?? null,
      centroid,
      geometry: geom,
    });
  }

  return NextResponse.json({ warnings });
}
