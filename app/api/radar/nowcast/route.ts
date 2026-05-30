// F9 (operator-approval): actionable couplet nowcast candidates for the
// /radar approval panel. Surfaces couplet_alerts rows the shadow dispatcher
// flagged as "would have fired" (status='shadow' — passed the environmental
// tier + shear threshold, has subscribers in the projected swath, and is not
// already covered by an NWS Tornado Warning). The operator reviews each and
// taps Send to DM the snapshotted swath audience.
//
// RLS-gated: public.couplet_alerts has an operator-only SELECT policy, so a
// non-operator session sees an empty list. No service-role access here — the
// dispatch write path (nowcast-actions.ts) handles the privileged enqueue.

import { supabaseServer } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Only surface freshly-fired candidates. The dispatcher dedups one row per
// track per 30 min, so the audience snapshot on a row is at most this old.
// Beyond the window the rotation has likely moved off the projected swath and
// the operator should wait for the next evaluation rather than send stale.
const WINDOW_MINUTES = 20;

export type NowcastCandidate = {
  id: string;
  track_id: string;
  fired_at: string;
  shear_kt: number;
  persistence_volumes: number;
  environment_tier: string | null;
  watch_event: string | null;
  latest_lat: number;
  latest_lon: number;
  motion_bearing_deg: number | null;
  motion_speed_kmh: number | null;
  projection_minutes: number | null;
  audience_count: number;
};

export async function GET() {
  const supa = supabaseServer();

  const cutoff = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();

  const { data, error } = await supa
    .from('couplet_alerts')
    .select(
      'id, track_id, fired_at, shear_kt, persistence_volumes, environment_tier, watch_event, latest_lat, latest_lon, motion_bearing_deg, motion_speed_kmh, projection_minutes, audience_count',
    )
    .eq('status', 'shadow')
    .gt('audience_count', 0)
    .gte('fired_at', cutoff)
    .order('fired_at', { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json(
      { candidates: [], error: error.message },
      { status: 200 },
    );
  }

  // Collapse to the most-recent row per track (defensive — the dispatcher
  // dedup makes >1 row per track inside this window rare, but a window that
  // straddles the 30-min dedup boundary could show two).
  const seen = new Set<string>();
  const candidates = (data ?? []).filter((c) => {
    if (seen.has(c.track_id)) return false;
    seen.add(c.track_id);
    return true;
  });

  return NextResponse.json(
    { candidates, window_minutes: WINDOW_MINUTES },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
