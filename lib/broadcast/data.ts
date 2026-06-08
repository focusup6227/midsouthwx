// Shared data-gathering for the broadcast suite. Reads PUBLIC NWS products
// only (SPC outlooks, active alerts, local storm reports) — no subscriber
// data ever touches these queries — so the overlay API can serve them to an
// unauthenticated OBS browser source via the service role, the same surface
// area as the /cards/* social-card routes.

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

export type BroadcastState = {
  generated_at: string;
  day1_label: string | null;
  warnings_count: number;
  watches_count: number;
  items: TickerItem[];
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

// Lightweight state for the OBS overlays (ticker, bug, counts). Cheap enough
// to poll every ~30s without a full briefing snapshot.
export async function gatherBroadcastState(client: SupabaseClient): Promise<BroadcastState> {
  const [{ data: snap }, items] = await Promise.all([
    client.rpc('daily_briefing_snapshot'),
    activeAlerts(client),
  ]);
  const s = (snap as SnapRow | null) ?? {};
  return {
    generated_at: s.generated_at ?? new Date().toISOString(),
    day1_label: s.spc?.['1']?.highest_label ?? null,
    warnings_count: s.warnings_count ?? 0,
    watches_count: s.watches_count ?? 0,
    items,
  };
}

// Full context for the AI scriptwriter: the briefing snapshot plus active
// alerts and recent local storm reports.
export async function gatherBroadcastContext(client: SupabaseClient): Promise<BroadcastContext> {
  const [{ data: snap }, alerts, { data: lsrs }] = await Promise.all([
    client.rpc('daily_briefing_snapshot'),
    activeAlerts(client),
    client
      .from('nws_storm_reports')
      .select('event, magnitude, location, occurred_at')
      .gte('occurred_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order('occurred_at', { ascending: false })
      .limit(30),
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
    warnings_count: s.warnings_count ?? 0,
    watches_count: s.watches_count ?? 0,
  };
}
