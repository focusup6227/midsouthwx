'use server';

import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const DispatchInput = z.object({ couplet_alert_id: z.string().uuid() });

// Hard ceiling on how old a candidate can be when dispatched. The snapshot
// audience and projected swath both go stale as the rotation moves; past this
// the operator should wait for a fresh evaluation rather than DM a swath the
// storm has already left.
const MAX_AGE_MINUTES = 25;

export type DispatchNowcastResult =
  | { ok: true; message_id: string; count: number }
  | { ok: false; error: string };

/**
 * Operator-approval dispatch for a couplet nowcast. Reads a shadow-mode
 * couplet_alerts row, then DMs the snapshotted swath audience an early
 * radar-based rotation heads-up. Reuses the standard message → outbound_queue
 * pipeline (source='manual' so it rings loud, overriding quiet hours — this
 * is a life-safety pre-alert). Never auto-fires: only this action, invoked by
 * the operator, turns a shadow row into a real send.
 */
export async function dispatchNowcast(
  input: z.infer<typeof DispatchInput>,
): Promise<DispatchNowcastResult> {
  const { couplet_alert_id } = DispatchInput.parse(input);
  const supa = supabaseServer();

  // Operator gate via the RLS-respecting client (mirrors compose/sendNow).
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return { ok: false, error: 'not authenticated' };
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!op) return { ok: false, error: 'operators only' };

  // Read the candidate under operator RLS so a non-operator can't dispatch a
  // row they can't see. couplet_alerts has an operator-only SELECT policy.
  const { data: row, error: readErr } = await supa
    .from('couplet_alerts')
    .select(
      'id, status, fired_at, environment_tier, watch_event, projection_minutes, audience_subscriber_ids',
    )
    .eq('id', couplet_alert_id)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: 'candidate not found' };

  if (row.status !== 'shadow') {
    return { ok: false, error: 'already handled (not a pending candidate)' };
  }
  const audience = (row.audience_subscriber_ids ?? []) as string[];
  if (audience.length === 0) {
    return { ok: false, error: 'no subscribers in the projected swath' };
  }
  const ageMs = Date.now() - new Date(row.fired_at).getTime();
  if (ageMs > MAX_AGE_MINUTES * 60_000) {
    return { ok: false, error: 'candidate is stale — wait for a fresh evaluation' };
  }

  const admin = supabaseAdmin();

  // Atomically claim the row (shadow → dispatched) so a double-tap or a second
  // operator tab can't fire twice. If no row comes back, someone else claimed
  // it first. We backfill message_id after the enqueue succeeds.
  const { data: claimed, error: claimErr } = await admin
    .from('couplet_alerts')
    .update({ status: 'dispatched' })
    .eq('id', couplet_alert_id)
    .eq('status', 'shadow')
    .select('id')
    .maybeSingle();
  if (claimErr) return { ok: false, error: claimErr.message };
  if (!claimed) return { ok: false, error: 'already dispatched' };

  const body = buildNowcastBody(row.projection_minutes, row.watch_event);

  try {
    const { data: msg, error: insertErr } = await admin
      .from('messages')
      .insert({
        body_md: body,
        body_rendered: body,
        source: 'manual',
        status: 'draft',
        audience_spec: { subscribers: audience },
        quick_replies: null,
        created_by: userId,
      })
      .select('id')
      .single();
    if (insertErr || !msg) throw new Error(insertErr?.message ?? 'message insert failed');

    const { data: count, error: enqErr } = await admin.rpc('enqueue_message_system', {
      p_message_id: msg.id,
    });
    if (enqErr) {
      await admin.from('messages').update({ status: 'failed' }).eq('id', msg.id);
      throw new Error(enqErr.message);
    }

    await admin
      .from('couplet_alerts')
      .update({ message_id: msg.id })
      .eq('id', couplet_alert_id);

    revalidatePath('/alerts');
    return { ok: true, message_id: msg.id, count: (count as unknown as number) ?? 0 };
  } catch (e) {
    // Roll the claim back so the candidate can be retried after the failure.
    await admin
      .from('couplet_alerts')
      .update({ status: 'shadow', message_id: null })
      .eq('id', couplet_alert_id);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function buildNowcastBody(
  projectionMinutes: number | null,
  watchEvent: string | null,
): string {
  const mins = projectionMinutes && projectionMinutes > 0 ? projectionMinutes : 10;
  const watchLine = watchEvent
    ? `A ${watchEvent} is already in effect for the area. `
    : '';
  return [
    '⚠️ ROTATION HEADS-UP',
    '',
    `${watchLine}Radar is showing strong rotation that may move over your location within the next ~${mins} minutes.`,
    '',
    'This is an early, radar-based alert from MidSouthWX — it is NOT an official National Weather Service Tornado Warning.',
    '',
    'Move to a safe place now: an interior room on the lowest floor, away from windows. Keep your phone on and watch for official warnings. We will follow up if this develops.',
  ].join('\n');
}
