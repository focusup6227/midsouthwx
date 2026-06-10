// Shared data-gathering for the broadcast suite. Reads PUBLIC weather data
// only (SPC outlooks, active alerts, local storm reports, and our own
// radar-derived rotation detections) — no subscriber data ever touches these
// queries — so the overlay API can serve them to an unauthenticated OBS
// browser source via the service role, the same surface area as the /cards/*
// social-card routes.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BroadcastContext } from '@/lib/ai/broadcast-script';

type SnapRow = {
  spc?: Record<string, { highest_label?: string | null; issued_at?: string | null; valid_from?: string | null; valid_until?: string | null }>;
  afds?: Array<{ wfo?: string; product_id?: string; issued_at?: string; synopsis?: string | null }>;
  hwos?: Array<{ event?: string; headline?: string | null; area_desc?: string | null; effective?: string | null; expires_at?: string | null }>;
  warnings_count?: number;
  watches_count?: number;
  generated_at?: string;
};

export type TickerItem = {
  event: string;
  area: string | null;
  severity: string | null;
  expires_at: string | null;
};

/** One live algorithm-detected velocity couplet ("rotation ID") per track. */
export type RotationTrack = {
  track_id: string;
  site: string;
  shear_kt: number;
  max_shear_kt: number;
  volume_count: number;
  last_seen_at: string | null;
};

export type BroadcastState = {
  generated_at: string;
  day1_label: string | null;
  /** SPC Day 1-3 highest categorical labels (null when no outlook on file). */
  spc_days: { day: number; label: string | null }[];
  warnings_count: number;
  watches_count: number;
  items: TickerItem[];
  /** Active rotation tracks from the couplet detector, strongest first. */
  rotation_tracks: RotationTrack[];
};

// Active warnings/watches, freshest first — used for both the AI script
// context and the on-air ticker. ['new','dispatched'] is the live set the NWS
// poller/dispatcher maintain (mirrors app/radar's warnings query); we then drop
// any row whose expiry has already passed so the ticker never shows stale ones.
async function activeAlerts(client: SupabaseClient): Promise<TickerItem[]> {
  const { data } = await client
    .from('nws_alerts')
    .select('event, area_desc, severity, headline, expires_at')
    .in('status', ['new', 'dispatched'])
    .or('event.ilike.%warning%,event.ilike.%watch%')
    .order('sent_at', { ascending: false })
    .limit(60);
  const now = Date.now();
  return (data ?? [])
    .filter((a) => !a.expires_at || new Date(a.expires_at as string).getTime() >= now)
    .slice(0, 40)
    .map((a) => ({
      event: String(a.event ?? 'Alert'),
      area: (a.area_desc as string | null) ?? (a.headline as string | null) ?? null,
      severity: (a.severity as string | null) ?? null,
      expires_at: (a.expires_at as string | null) ?? null,
    }));
}

// Live rotation tracks from the F9 couplet detector (radar_couplets table,
// fed by couplet-poll). Uses the same radar_couplets_geojson RPC as /radar:
// latest detection per track over the recency window, strongest shear first.
// 20-minute window ≈ the last 3-4 volume scans — long enough to keep a
// persistent meso on screen between scans, short enough that a dissipated
// one drops off the air quickly. Best-effort: a missing RPC (migration not
// applied) or transient error just renders no rotation rather than failing
// the whole state feed.
async function activeRotationTracks(client: SupabaseClient): Promise<RotationTrack[]> {
  const { data, error } = await client.rpc('radar_couplets_geojson', { p_minutes: 20 });
  if (error || !data) return [];
  const features = (data as { features?: Array<{ properties?: Record<string, unknown> }> }).features ?? [];
  return features.slice(0, 8).map((f) => {
    const p = f.properties ?? {};
    return {
      track_id: String(p.track_id ?? '?'),
      site: String(p.site ?? '?'),
      shear_kt: Math.round(Number(p.shear_kt ?? 0)),
      max_shear_kt: Math.round(Number(p.max_shear_kt ?? p.shear_kt ?? 0)),
      volume_count: Number(p.volume_count ?? 1),
      last_seen_at: (p.last_seen_at as string | null) ?? (p.volume_time_utc as string | null) ?? null,
    };
  });
}

// Lightweight state for the OBS overlays (ticker, bug, counts). Cheap enough
// to poll every ~30s without a full briefing snapshot.
export async function gatherBroadcastState(client: SupabaseClient): Promise<BroadcastState> {
  const [{ data: snap }, items, rotationTracks] = await Promise.all([
    client.rpc('daily_briefing_snapshot'),
    activeAlerts(client),
    activeRotationTracks(client),
  ]);
  const s = (snap as SnapRow | null) ?? {};
  return {
    generated_at: s.generated_at ?? new Date().toISOString(),
    day1_label: s.spc?.['1']?.highest_label ?? null,
    spc_days: [1, 2, 3].map((d) => ({ day: d, label: s.spc?.[String(d)]?.highest_label ?? null })),
    warnings_count: s.warnings_count ?? 0,
    watches_count: s.watches_count ?? 0,
    items,
    rotation_tracks: rotationTracks,
  };
}

// Full context for the AI scriptwriter: the briefing snapshot plus active
// alerts and recent local storm reports.
export async function gatherBroadcastContext(client: SupabaseClient): Promise<BroadcastContext> {
  const [{ data: snap }, alerts, { data: lsrs }, rotationTracks, { data: forecasts }] = await Promise.all([
    client.rpc('daily_briefing_snapshot'),
    activeAlerts(client),
    client
      .from('nws_storm_reports')
      .select('event, magnitude, location, occurred_at')
      .gte('occurred_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order('occurred_at', { ascending: false })
      .limit(30),
    activeRotationTracks(client),
    // The operator's own issued forecasts whose window is still open — the
    // script must align with (not contradict) what was already published.
    client
      .from('forecasts')
      .select('title, hazards, confidence, valid_from, valid_until, discussion')
      .eq('status', 'issued')
      .gte('valid_until', new Date().toISOString())
      .order('valid_from', { ascending: true })
      .limit(3),
  ]);
  const s = (snap as SnapRow | null) ?? {};
  return {
    generated_at: s.generated_at ?? new Date().toISOString(),
    spc: s.spc ?? {},
    afds: s.afds ?? [],
    hwos: s.hwos ?? [],
    alerts: alerts.map((a) => ({
      event: a.event,
      area_desc: a.area,
      severity: a.severity,
      headline: a.area,
      expires_at: a.expires_at,
    })),
    lsrs: (lsrs ?? []) as BroadcastContext['lsrs'],
    couplets: rotationTracks,
    operator_forecasts: (forecasts ?? []) as BroadcastContext['operator_forecasts'],
    warnings_count: s.warnings_count ?? 0,
    watches_count: s.watches_count ?? 0,
  };
}
