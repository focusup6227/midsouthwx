'use server';

import { supabaseServer, supabaseAdmin } from '@/lib/supabase/server';
import { gatherBroadcastContext, type OverlayControl } from '@/lib/broadcast/data';
import { generateBroadcastScript, type BroadcastScript } from '@/lib/ai/broadcast-script';

export type GenerateScriptResult =
  | { ok: true; script: BroadcastScript; generated_at: string }
  | { ok: false; error: string };

// Drafts the spoken broadcast script + YouTube package from the current live
// weather data. Operator-only: we confirm a session via the RLS-respecting
// SSR client, then read the (public) NWS source data with the service role so
// the briefing-snapshot RPC and storm-report table resolve regardless of the
// caller's row policies. Nothing is persisted — the result lives client-side
// until the operator records.
export async function generateScriptAction(input: {
  mode: 'live' | 'recorded';
  target_minutes: number;
  user_note?: string;
}): Promise<GenerateScriptResult> {
  const supa = supabaseServer();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const minutes = Math.min(20, Math.max(1, Math.round(input.target_minutes || 3)));

  try {
    const context = await gatherBroadcastContext(supabaseAdmin());
    const { script } = await generateBroadcastScript({
      context,
      mode: input.mode === 'live' ? 'live' : 'recorded',
      target_minutes: minutes,
      user_note: input.user_note?.slice(0, 600),
    });
    return { ok: true, script, generated_at: context.generated_at ?? new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to generate script' };
  }
}

// Updates the live overlay-control singleton that ?live=1 overlays read. The
// only writeable fields are the operator-authored text/visibility flags below;
// everything is operator-gated. Returns the saved row so the console can keep
// its inputs in sync.
export async function updateControlAction(
  patch: Partial<OverlayControl>,
): Promise<{ ok: true; control: OverlayControl } | { ok: false; error: string }> {
  const supa = supabaseServer();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  // Whitelist + lightly bound the inputs so the action can't be coerced into
  // writing unexpected columns or oversized strings.
  const clean: Record<string, unknown> = { id: true, updated_at: new Date().toISOString() };
  if (patch.brand !== undefined) clean.brand = String(patch.brand).slice(0, 60);
  if (patch.accent !== undefined) clean.accent = String(patch.accent).slice(0, 16);
  if (patch.lower_third_title !== undefined) clean.lower_third_title = String(patch.lower_third_title).slice(0, 80);
  if (patch.lower_third_subtitle !== undefined) clean.lower_third_subtitle = String(patch.lower_third_subtitle).slice(0, 120);
  if (patch.lower_third_visible !== undefined) clean.lower_third_visible = !!patch.lower_third_visible;
  if (patch.bug_visible !== undefined) clean.bug_visible = !!patch.bug_visible;
  if (patch.ticker_visible !== undefined) clean.ticker_visible = !!patch.ticker_visible;

  // Write through the RLS client: the broadcast_control "is_operator()" policy
  // enforces operator-only writes, so a logged-in non-operator is blocked here
  // (the public state endpoint still reads it via the service role).
  const { data, error } = await supa
    .from('broadcast_control')
    .upsert(clean, { onConflict: 'id' })
    .select('brand, accent, lower_third_title, lower_third_subtitle, lower_third_visible, bug_visible, ticker_visible')
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? 'Update failed' };
  return { ok: true, control: data as OverlayControl };
}
