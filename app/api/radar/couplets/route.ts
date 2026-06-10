// F9: Recent NEXRAD velocity-couplet detections ("rotation IDs") as a
// GeoJSON FeatureCollection for the /radar map layer. One feature per
// stable track_id within the time window, located at its most-recent
// detection point. Also exposes the trail per track as a second
// FeatureCollection so the frontend can render meso paths.
//
// Backed by the public.radar_couplets_geojson(mins) +
// public.radar_couplets_tracks_geojson(mins) RPCs which apply the time
// window and stitch the trail in one round-trip each.

import { parseFeatureCollection } from '@/lib/radar/geojson-utils';
import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 180;

export async function GET(req: Request) {
  const supa = supabaseServer();
  const url = new URL(req.url);
  const minutesParam = parseInt(url.searchParams.get('minutes') ?? '', 10);
  const minutes = Number.isFinite(minutesParam)
    ? Math.max(1, Math.min(MAX_MINUTES, minutesParam))
    : DEFAULT_MINUTES;

  const [pts, trails] = await Promise.all([
    supa.rpc('radar_couplets_geojson', { p_minutes: minutes }),
    supa.rpc('radar_couplets_tracks_geojson', { p_minutes: minutes }),
  ]);

  if (pts.error) {
    return NextResponse.json(
      {
        geojson: { type: 'FeatureCollection', features: [] },
        tracks: { type: 'FeatureCollection', features: [] },
        error: pts.error.message,
      },
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      geojson: parseFeatureCollection<GeoJSON.Point>(pts.data),
      tracks: parseFeatureCollection<GeoJSON.LineString>(trails.data),
      minutes,
    },
    {
      // Edge function polls every 60 s, so the underlying data can't change
      // faster than that — match the edge cache to the source cadence so
      // repeat/parallel loads within a poll cycle are served from the CDN
      // instead of re-querying Postgres. SWR also refreshes every 60 s.
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    },
  );
}
