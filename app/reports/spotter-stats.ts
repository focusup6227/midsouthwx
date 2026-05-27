// Bulk fetch of spotter aggregates so the triage list can render a small
// reliability badge next to each reporter without a per-row N+1.

import { supabaseServer } from '@/lib/supabase/server';

export type SpotterStats = {
  subscriber_id: string;
  total_reports: number;
  verified_count: number;
  promoted_count: number;
  dismissed_count: number;
  new_count: number;
  last_confirmed_at: string | null;
};

export async function fetchSpotterStats(
  subscriberIds: string[],
): Promise<Map<string, SpotterStats>> {
  const map = new Map<string, SpotterStats>();
  if (subscriberIds.length === 0) return map;
  const supa = supabaseServer();
  const { data } = await supa
    .from('subscriber_spotter_stats')
    .select('subscriber_id, total_reports, verified_count, promoted_count, dismissed_count, new_count, last_confirmed_at')
    .in('subscriber_id', subscriberIds);
  for (const row of (data ?? []) as SpotterStats[]) {
    map.set(row.subscriber_id, row);
  }
  return map;
}

/** Lightweight summary used by inline badges. Returns null when the spotter
 *  has fewer than 2 reports — a single submission isn't enough to score. */
export function summarizeReliability(stats: SpotterStats | undefined): {
  label: string;
  confirmed: number;
  total: number;
  tint: string;
} | null {
  if (!stats || stats.total_reports < 2) return null;
  const confirmed = stats.verified_count + stats.promoted_count;
  const ratio = confirmed / stats.total_reports;
  const tint =
    ratio >= 0.66 ? 'text-emerald-300'
    : ratio >= 0.33 ? 'text-amber-300'
    : 'text-wx-mute';
  return {
    label: `${confirmed}/${stats.total_reports} confirmed`,
    confirmed,
    total: stats.total_reports,
    tint,
  };
}
