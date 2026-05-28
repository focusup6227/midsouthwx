'use server';

import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { generateForecastDraft, type ForecastContext, type ForecastDraft } from '@/lib/ai/forecast-draft';

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
