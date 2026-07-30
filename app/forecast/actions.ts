'use server';

import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { generateForecastDraft, type ForecastContext, type ForecastDraft } from '@/lib/ai/forecast-draft';
import { sampleConvectiveContext } from '@/lib/forecast/open-meteo';
import { sampleSevereParams } from '@/lib/forecast/severe-sample';

// Mirrors compose page's HAZARD_KINDS (app/compose/page.tsx:44). Keeping these
// in lockstep matters because the forecast → compose hand-off forwards
// hazards verbatim into ?hazard=… and compose only honors values in its set.
const HAZARDS = ['tornado', 'severe', 'flood', 'winter', 'heat', 'wind'] as const;
type Hazard = (typeof HAZARDS)[number];

// GeoJSON Position is [lng, lat] or [lng, lat, alt] — accept either; we only
// use the first two when we hand it to PostGIS. The min(4) on the ring matches
// GeoJSON's "ring must close" rule (first = last, so ≥4 points).
const PolygonCoord = z.array(z.number()).min(2).max(3);
const PolygonGeoJSON = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(PolygonCoord).min(4)).min(1),
});

const SaveInput = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').max(120),
  hazards: z.array(z.enum(HAZARDS)).min(1, 'Pick at least one hazard'),
  confidence: z.enum(['low', 'moderate', 'high']).nullable(),
  valid_from: z.string().datetime({ offset: true }),
  valid_until: z.string().datetime({ offset: true }),
  discussion: z.string().max(8000).optional().nullable(),
  area: PolygonGeoJSON,
  // Optional audit fields populated only when an AI draft seeded the form.
  // ai_draft holds the raw model response; source_refs holds the context
  // snapshot we sent to the model. The form clears these when the operator
  // discards or restarts the draft.
  ai_draft: z.unknown().optional().nullable(),
  source_refs: z.record(z.unknown()).optional().nullable(),
});

export type SaveForecastInput = z.infer<typeof SaveInput>;

export async function saveForecast(input: SaveForecastInput): Promise<{ id: string }> {
  const parsed = SaveInput.parse(input);
  if (new Date(parsed.valid_until) <= new Date(parsed.valid_from)) {
    throw new Error('valid_until must be after valid_from');
  }

  const supa = supabaseServer();
  const { data, error } = await supa.rpc('forecast_create', {
    p_title: parsed.title,
    p_hazards: parsed.hazards,
    p_confidence: parsed.confidence,
    p_area: parsed.area,
    p_valid_from: parsed.valid_from,
    p_valid_until: parsed.valid_until,
    p_discussion: parsed.discussion ?? null,
    p_source_refs: parsed.source_refs ?? {},
    p_ai_draft: parsed.ai_draft ?? null,
    p_status: 'draft',
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('forecast_create returned no id');

  revalidatePath('/forecast');
  return { id: data as string };
}

// AI draft entry-point invoked from ForecastForm's "AI draft" button. Pulls
// the snapshot via forecast_context RPC, hands it to DeepSeek, returns the
// model output plus the raw snapshot so the form can persist both fields
// alongside the saved row (ai_draft + source_refs jsonb columns).
const DraftRequest = z.object({
  area: PolygonGeoJSON,
  valid_from: z.string().datetime({ offset: true }),
  valid_until: z.string().datetime({ offset: true }),
  hazards_hint: z.array(z.enum(HAZARDS)).default([]),
  user_note: z.string().max(600).optional().nullable(),
});

export type DraftForecastInput = z.infer<typeof DraftRequest>;
export type DraftForecastResult = {
  draft: ForecastDraft;
  ai_draft: { prompt: string; response: unknown; generated_at: string };
  source_refs: ForecastContext;
};

export async function draftForecast(input: DraftForecastInput): Promise<DraftForecastResult> {
  const parsed = DraftRequest.parse(input);

  const supa = supabaseServer();
  const { data: context, error: ctxErr } = await supa.rpc('forecast_context', {
    p_area: parsed.area,
    p_lookback_hours: 24,
  });
  if (ctxErr) throw new Error(`context: ${ctxErr.message}`);
  if (!context) throw new Error('forecast_context returned no data');

  const ctx = context as ForecastContext;

  // Enrich the text snapshot with quantitative thermodynamics sampled at the
  // area centroid over the valid window. Best-effort — a null sample leaves the
  // draft text-only. Persisted into source_refs so the audit trail records the
  // numbers the model actually saw.
  const centroid = ctx.area_centroid?.coordinates;
  if (centroid && centroid.length >= 2) {
    const [lng, lat] = centroid;
    // Thermo (Open-Meteo, over the window) + kinematics (HRRR, current analysis)
    // sampled in parallel; both best-effort and independent.
    const [thermo, severe] = await Promise.all([
      sampleConvectiveContext(lat, lng, parsed.valid_from, parsed.valid_until),
      sampleSevereParams(lat, lng),
    ]);
    ctx.thermo = thermo;
    ctx.severe = severe;
  }

  const { draft, raw, prompt } = await generateForecastDraft({
    context: ctx,
    valid_from: parsed.valid_from,
    valid_until: parsed.valid_until,
    hazards_hint: parsed.hazards_hint,
    user_note: parsed.user_note ?? undefined,
  });

  return {
    draft,
    ai_draft: { prompt, response: raw, generated_at: new Date().toISOString() },
    source_refs: ctx,
  };
}

// ── Draft-time situation preview ─────────────────────────────────────────
// The same forecast_context() snapshot the AI sees, trimmed for a sidebar
// panel — so the operator reads SPC/AFD/alerts/LSRs on the form instead of
// tab-hopping to /forecast/data. No model call, no thermo sampling: fast.

export type SituationPreview = {
  spc: { day: number; label: string | null; overlap: string[] }[];
  /** SPC Days 4-8 (probabilistic) — region-wide highest label per day. */
  extended: { day: number; label: string | null }[];
  /** NBM-derived thunder probability at the centroid over the next ~36 h. */
  thunder: { max: number; peak_at: string | null } | null;
  afd: { wfo: string | null; issued_at: string | null; synopsis: string | null } | null;
  alerts: { event: string; headline: string | null }[];
  alerts_total: number;
  lsr_total: number;
  lsrs_by_hazard: Record<string, number>;
  suggested: Hazard[];
};

async function sampleThunderProbability(
  lat: number,
  lng: number,
): Promise<{ max: number; peak_at: string | null } | null> {
  const ua = { 'User-Agent': process.env.NWS_USER_AGENT ?? 'midsouthwx' };
  try {
    const pt = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`, {
      headers: ua,
      signal: AbortSignal.timeout(10_000),
    });
    if (!pt.ok) return null;
    const gridUrl = (await pt.json())?.properties?.forecastGridData as string | undefined;
    if (!gridUrl) return null;
    const grid = await fetch(gridUrl, { headers: ua, signal: AbortSignal.timeout(15_000) });
    if (!grid.ok) return null;
    const values = (await grid.json())?.properties?.probabilityOfThunder?.values as
      | { validTime: string; value: number | null }[]
      | undefined;
    if (!values?.length) return null;
    const cutoff = Date.now() + 36 * 3600_000;
    let max = 0;
    let peakAt: string | null = null;
    for (const v of values) {
      const t = new Date(v.validTime.split('/')[0]).getTime();
      if (!Number.isFinite(t) || t > cutoff || v.value == null) continue;
      if (v.value > max) {
        max = v.value;
        peakAt = v.validTime.split('/')[0];
      }
    }
    return { max, peak_at: peakAt };
  } catch {
    return null;
  }
}

const SEVERE_LABELS = new Set(['SLGT', 'ENH', 'MDT', 'HIGH']);
const TOR_LABELS = new Set(['MDT', 'HIGH']);

function suggestHazards(ctx: {
  overlap1: string[];
  alerts: { event?: string | null }[];
  lsrHazards: string[];
}): Hazard[] {
  const out = new Set<Hazard>();
  if (ctx.overlap1.some((l) => SEVERE_LABELS.has(l))) out.add('severe');
  if (ctx.overlap1.some((l) => TOR_LABELS.has(l))) out.add('tornado');
  for (const a of ctx.alerts) {
    const e = (a.event ?? '').toLowerCase();
    if (e.includes('tornado')) out.add('tornado');
    else if (e.includes('severe')) out.add('severe');
    else if (e.includes('flood')) out.add('flood');
    else if (e.includes('wind')) out.add('wind');
    else if (e.includes('heat')) out.add('heat');
    else if (e.includes('winter') || e.includes('ice') || e.includes('snow')) out.add('winter');
  }
  for (const h of ctx.lsrHazards) {
    const l = h.toLowerCase();
    if (l.includes('tornado')) out.add('tornado');
    else if (l.includes('hail') || l.includes('severe')) out.add('severe');
    else if (l.includes('wind')) out.add('wind');
    else if (l.includes('flood')) out.add('flood');
  }
  return [...out];
}

export async function previewForecastContext(input: {
  area: z.infer<typeof PolygonGeoJSON>;
}): Promise<SituationPreview> {
  const area = PolygonGeoJSON.parse(input.area);
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('forecast_context', {
    p_area: area,
    p_lookback_hours: 24,
  });
  if (error) throw new Error(error.message);
  const ctx = (data ?? {}) as ForecastContext & { spc_overlap?: Record<string, string[]> };

  const overlap = ctx.spc_overlap ?? {};
  const spc = [1, 2, 3].map((day) => {
    const row = (ctx.spc ?? []).find((s) => s.day_number === day);
    return {
      day,
      label: row?.highest_label ?? null,
      overlap: overlap[String(day)] ?? [],
    };
  });

  // Extended outlook + thunder trace fetched alongside (best-effort).
  const ring = area.coordinates[0] ?? [];
  const centroidLng = ring.reduce((s, p) => s + p[0], 0) / Math.max(1, ring.length);
  const centroidLat = ring.reduce((s, p) => s + p[1], 0) / Math.max(1, ring.length);
  const [extendedRows, thunder] = await Promise.all([
    supa
      .from('spc_outlooks')
      .select('day_number, highest_label')
      .gte('day_number', 4)
      .order('day_number')
      .then((r) => (r.error ? [] : r.data ?? []), () => []),
    sampleThunderProbability(centroidLat, centroidLng),
  ]);
  const extended = extendedRows.map((r) => ({
    day: r.day_number as number,
    label: (r.highest_label as string | null) ?? null,
  }));

  const lsrsByHazard: Record<string, number> = {};
  for (const l of ctx.lsrs ?? []) {
    const h = l.hazard ?? 'other';
    lsrsByHazard[h] = (lsrsByHazard[h] ?? 0) + 1;
  }

  return {
    spc,
    extended,
    thunder,
    afd: ctx.afd
      ? {
          wfo: ctx.afd.wfo ?? null,
          issued_at: ctx.afd.issued_at ?? null,
          synopsis: ctx.afd.ai_summary ?? ctx.afd.synopsis ?? null,
        }
      : null,
    alerts: (ctx.alerts ?? []).slice(0, 5).map((a) => ({
      event: a.event ?? 'Alert',
      headline: a.headline ?? null,
    })),
    alerts_total: (ctx.alerts ?? []).length,
    lsr_total: (ctx.lsrs ?? []).length,
    lsrs_by_hazard: lsrsByHazard,
    suggested: suggestHazards({
      overlap1: overlap['1'] ?? [],
      alerts: ctx.alerts ?? [],
      lsrHazards: Object.keys(lsrsByHazard),
    }),
  };
}

// Recent areas for one-click carry-forward — redrawing the same Mid-South
// polygon every morning was pure friction.
export type RecentArea = {
  id: string;
  title: string;
  created_at: string;
  area: GeoJSON.Polygon;
};

export async function recentForecastAreas(): Promise<RecentArea[]> {
  const supa = supabaseServer();
  const { data: rows } = await supa
    .from('forecasts')
    .select('id, title, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  const out: RecentArea[] = [];
  for (const f of rows ?? []) {
    const { data: area } = await supa.rpc('forecast_area_geojson', { p_id: f.id });
    if (!area) continue;
    const g = area as GeoJSON.Polygon | GeoJSON.MultiPolygon;
    // Stored as MultiPolygon; the form draws a single ring.
    const poly: GeoJSON.Polygon =
      g.type === 'MultiPolygon'
        ? { type: 'Polygon', coordinates: g.coordinates[0] ?? [] }
        : g;
    if (!poly.coordinates?.length) continue;
    out.push({ id: f.id, title: f.title, created_at: f.created_at, area: poly });
  }
  return out;
}

// 90-day per-hazard skill so confidence is calibrated against the operator's
// own track record while drafting, not remembered vaguely.
export type HazardSkill = {
  hits: number;
  misses: number;
  false_alarms: number;
  pod: number | null;
  far: number | null;
};

export async function hazardSkillSummary(): Promise<Record<string, HazardSkill>> {
  const supa = supabaseServer();
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const { data } = await supa
    .from('forecasts')
    .select('verification')
    .not('verification', 'is', null)
    .gte('created_at', since)
    .limit(400);

  const agg: Record<string, HazardSkill> = {};
  const bump = (h: string, k: 'hits' | 'misses' | 'false_alarms') => {
    agg[h] ??= { hits: 0, misses: 0, false_alarms: 0, pod: null, far: null };
    agg[h][k]++;
  };
  for (const row of data ?? []) {
    const v = row.verification as {
      matched_hazards?: string[];
      missed_hazards?: string[];
      false_alarm_hazards?: string[];
    } | null;
    if (!v) continue;
    for (const h of v.matched_hazards ?? []) bump(h, 'hits');
    for (const h of v.missed_hazards ?? []) bump(h, 'misses');
    for (const h of v.false_alarm_hazards ?? []) bump(h, 'false_alarms');
  }
  for (const s of Object.values(agg)) {
    s.pod = s.hits + s.misses > 0 ? s.hits / (s.hits + s.misses) : null;
    s.far = s.hits + s.false_alarms > 0 ? s.false_alarms / (s.hits + s.false_alarms) : null;
  }
  return agg;
}

// Hand-off to /compose: builds the same query-param contract /compose already
// accepts (geo + hazard + body — see app/compose/page.tsx:14-80). We pass the
// area as a Polygon (single outer ring) which normalizeGeometry wraps into
// canonical { type: 'Polygon', coordinates: [ring] } for resolve_audience.
//
// hazard query param is single-valued in compose (it picks one template), so
// when multiple hazards are set we forward the highest-priority one. Other
// hazards still live in the saved forecast row.
const HAZARD_PRIORITY: Hazard[] = ['tornado', 'flood', 'severe', 'wind', 'winter', 'heat'];

export async function composeFromForecast(id: string): Promise<never> {
  const supa = supabaseServer();
  const { data: row, error } = await supa
    .from('forecasts')
    .select('id, title, hazards, discussion')
    .eq('id', id)
    .single();
  if (error || !row) throw new Error(error?.message ?? 'forecast not found');

  const { data: areaJson, error: aerr } = await supa.rpc('forecast_area_geojson', { p_id: id });
  if (aerr || !areaJson) throw new Error(aerr?.message ?? 'could not load forecast area');

  const params = new URLSearchParams();
  params.set('geo', JSON.stringify(areaJson));

  const hazards = (row.hazards ?? []) as Hazard[];
  const primary = HAZARD_PRIORITY.find((h) => hazards.includes(h));
  if (primary) params.set('hazard', primary);

  const body = composeBody(row.title, row.discussion);
  if (body) params.set('body', body.slice(0, 1000));

  redirect(`/compose?${params.toString()}`);
}

// Operator-triggered rescore. Wraps the forecast_rescore SQL RPC and
// invalidates the detail-page cache so the new verification jsonb renders
// on the next request. The Scorecard binds the id and posts a form to
// trigger this without a client wrapper.
export async function rescoreForecast(id: string): Promise<void> {
  const supa = supabaseServer();
  const { error } = await supa.rpc('forecast_rescore', { p_id: id });
  if (error) throw new Error(error.message);
  revalidatePath(`/forecast/${id}`);
  revalidatePath('/forecast');
}

function composeBody(title: string, discussion: string | null): string {
  const t = (title ?? '').trim();
  const d = (discussion ?? '').trim();
  if (!t && !d) return '';
  if (!d) return t;
  if (!t) return d;
  return `${t}\n\n${d}`;
}

// Direct broadcast — no /compose detour. Builds an audience_spec from the
// forecast's polygon, inserts a messages row + enqueues, marks the forecast
// 'issued' and links broadcast_message_id back so the detail page can show
// the outbound stats.
export async function broadcastForecast(id: string): Promise<{ message_id: string; count: number }> {
  const supa = supabaseServer();
  const admin = supabaseAdmin();

  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) throw new Error('not authenticated');

  const { data: forecast, error: ferr } = await supa
    .from('forecasts')
    .select('id, title, hazards, confidence, discussion, status, public_token, broadcast_message_id')
    .eq('id', id)
    .maybeSingle();
  if (ferr || !forecast) throw new Error(ferr?.message ?? 'forecast not found');
  if (forecast.broadcast_message_id) {
    throw new Error('forecast already broadcast — use Resend from /m/<id> to refire');
  }

  const { data: areaJson, error: aerr } = await supa.rpc('forecast_area_geojson', { p_id: id });
  if (aerr || !areaJson) throw new Error(aerr?.message ?? 'could not load forecast area');

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ?? '';
  const publicLink = forecast.public_token && siteUrl
    ? `\n\nFull discussion: ${siteUrl}/f/${forecast.public_token}`
    : '';
  const body = (composeBody(forecast.title, forecast.discussion) + publicLink).trim();
  if (!body) throw new Error('forecast has no body to broadcast');

  const audienceSpec = { geometry: areaJson };

  const { data: msg, error: insertErr } = await admin
    .from('messages')
    .insert({
      body_md: body,
      body_rendered: body,
      source: 'manual',
      status: 'draft',
      audience_spec: audienceSpec,
      created_by: userId,
    })
    .select('id')
    .single();
  if (insertErr || !msg) throw new Error(insertErr?.message ?? 'insert failed');

  const { data: count, error: enqErr } = await admin.rpc('enqueue_message_system', {
    p_message_id: msg.id,
  });
  if (enqErr) {
    await admin.from('messages').update({ status: 'failed' }).eq('id', msg.id);
    throw new Error(enqErr.message);
  }

  const wantsIssued = forecast.status === 'draft' || forecast.status === 'ai_draft';
  await admin
    .from('forecasts')
    .update({
      status: wantsIssued ? 'issued' : forecast.status,
      broadcast_message_id: msg.id,
      broadcast_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  revalidatePath(`/forecast/${id}`);
  revalidatePath('/forecast');
  return { message_id: msg.id, count: (count as unknown as number) ?? 0 };
}

// Mint or revoke the public share token. Issuing one flips visibility to
// "anyone with the link" — combined with the migration's anon-select policy
// gating on (public_token IS NOT NULL AND status IN ('issued','closed')),
// drafts stay private even if a token was created early.
export async function enableForecastSharing(id: string): Promise<{ token: string }> {
  const supa = supabaseServer();
  const { data: existing } = await supa
    .from('forecasts')
    .select('public_token')
    .eq('id', id)
    .maybeSingle();
  if (existing?.public_token) {
    revalidatePath(`/forecast/${id}`);
    return { token: existing.public_token };
  }
  // 16 bytes → 22 url-safe chars. Plenty of entropy; short enough to share.
  const token = randomBytes(16).toString('base64url');
  const { error } = await supa
    .from('forecasts')
    .update({ public_token: token, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath(`/forecast/${id}`);
  return { token };
}

export async function disableForecastSharing(id: string): Promise<void> {
  const supa = supabaseServer();
  const { error } = await supa
    .from('forecasts')
    .update({ public_token: null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath(`/forecast/${id}`);
}
