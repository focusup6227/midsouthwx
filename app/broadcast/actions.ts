'use server';

import { supabaseServer, supabaseAdmin } from '@/lib/supabase/server';
import { gatherBroadcastContext } from '@/lib/broadcast/data';
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
