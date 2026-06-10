'use server';

import { supabaseServer, supabaseAdmin } from '@/lib/supabase/server';
import { gatherBroadcastContext } from '@/lib/broadcast/data';
import { generateBroadcastScript, type BroadcastScript } from '@/lib/ai/broadcast-script';

export type GenerateScriptResult =
  | { ok: true; script: BroadcastScript; generated_at: string; saved_id: string | null }
  | { ok: false; error: string };

// Drafts the spoken broadcast script + YouTube package from the current live
// weather data. Operator-only: we confirm a session via the RLS-respecting
// SSR client, then read the (public) NWS source data with the service role so
// the briefing-snapshot RPC and storm-report table resolve regardless of the
// caller's row policies. The result is also archived to broadcast_scripts so
// past scripts can be reloaded from the library; the localStorage copy remains
// the console → teleprompter hand-off.
export async function generateScriptAction(input: {
  mode: 'live' | 'recorded';
  target_minutes: number;
  user_note?: string;
}): Promise<GenerateScriptResult> {
  const supa = supabaseServer();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const minutes = Math.min(20, Math.max(1, Math.round(input.target_minutes || 3)));
  const mode = input.mode === 'live' ? 'live' : 'recorded';

  try {
    const context = await gatherBroadcastContext(supabaseAdmin());
    const { script } = await generateBroadcastScript({
      context,
      mode,
      target_minutes: minutes,
      user_note: input.user_note?.slice(0, 600),
    });
    const generated_at = context.generated_at ?? new Date().toISOString();

    // Archive to the library. Best-effort: a failed insert (e.g. migration
    // not applied yet) must not eat a successfully generated script.
    let savedId: string | null = null;
    const { data: savedRow } = await supa
      .from('broadcast_scripts')
      .insert({
        created_by: user.id,
        title: script.title,
        summary: script.summary || null,
        mode,
        target_minutes: minutes,
        script,
        context_generated_at: generated_at,
      })
      .select('id')
      .single();
    savedId = (savedRow?.id as string | undefined) ?? null;

    return { ok: true, script, generated_at, saved_id: savedId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to generate script' };
  }
}

// ── Script library ──────────────────────────────────────────────────────────

export type SavedScriptMeta = {
  id: string;
  title: string;
  summary: string | null;
  mode: 'live' | 'recorded';
  target_minutes: number;
  context_generated_at: string | null;
  created_at: string;
};

export async function listSavedScripts(): Promise<SavedScriptMeta[]> {
  const supa = supabaseServer();
  const { data, error } = await supa
    .from('broadcast_scripts')
    .select('id, title, summary, mode, target_minutes, context_generated_at, created_at')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  return (data ?? []) as SavedScriptMeta[];
}

export async function loadSavedScript(
  id: string,
): Promise<{ script: BroadcastScript; context_generated_at: string | null }> {
  const supa = supabaseServer();
  const { data, error } = await supa
    .from('broadcast_scripts')
    .select('script, context_generated_at')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'script not found');
  return {
    script: data.script as BroadcastScript,
    context_generated_at: (data.context_generated_at as string | null) ?? null,
  };
}

export async function deleteSavedScript(id: string): Promise<void> {
  const supa = supabaseServer();
  const { error } = await supa.from('broadcast_scripts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
