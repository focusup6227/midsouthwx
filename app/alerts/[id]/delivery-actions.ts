'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';

const uuid = z.string().uuid();

/**
 * Re-queue every failed delivery for a message. Resets the rows to pending
 * so telegram-send-worker picks them up on its next tick — same pipeline,
 * fresh attempt counter.
 */
export async function retryFailedDeliveries(
  messageId: string,
): Promise<{ ok: true; retried: number } | { error: string }> {
  const idParse = uuid.safeParse(messageId);
  if (!idParse.success) return { error: 'Invalid message id' };

  const supa = supabaseServer();
  const { data, error } = await supa
    .from('outbound_queue')
    .update({
      status: 'pending',
      attempts: 0,
      last_error: null,
      send_after: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
    })
    .eq('message_id', idParse.data)
    .eq('status', 'failed')
    .select('id');

  if (error) return { error: error.message };
  revalidatePath(`/alerts/${idParse.data}`);
  return { ok: true, retried: data?.length ?? 0 };
}

/**
 * Send a follow-up check-in to recipients of the original alert who haven't
 * responded. Creates a fresh source='checkin' message targeting exactly the
 * non-responders — its own tally/thread, standard pipeline.
 */
export async function remindNonResponders(
  messageId: string,
): Promise<{ ok: true; reminded: number; newMessageId: string } | { error: string }> {
  const idParse = uuid.safeParse(messageId);
  if (!idParse.success) return { error: 'Invalid message id' };

  const supa = supabaseServer();

  const [{ data: sentRows, error: sentErr }, { data: responded, error: respErr }] = await Promise.all([
    supa
      .from('outbound_queue')
      .select('subscriber_id')
      .eq('message_id', idParse.data)
      .eq('status', 'sent'),
    supa
      .from('check_in_responses')
      .select('subscriber_id')
      .eq('message_id', idParse.data),
  ]);
  if (sentErr) return { error: sentErr.message };
  if (respErr) return { error: respErr.message };

  const respondedSet = new Set((responded ?? []).map((r) => r.subscriber_id));
  const targets = [...new Set((sentRows ?? []).map((r) => r.subscriber_id))].filter(
    (id) => !respondedSet.has(id),
  );
  if (targets.length === 0) return { error: 'Everyone has already responded.' };

  const body =
    '👋 **Checking in again** — we have not heard back from you after the earlier alert. '
    + "Tap a button below so we know you're okay. If you need help, tap 🆘 and someone will follow up.";

  const { data: newMsg, error: insErr } = await supa
    .from('messages')
    .insert({
      body_md: body,
      body_rendered: body,
      source: 'checkin',
      status: 'draft',
      audience_spec: { subscribers: targets },
      quick_replies: [
        { label: "✅ I'm safe", data: 'safe' },
        { label: '🆘 Need help', data: 'help' },
      ],
    })
    .select('id')
    .single();
  if (insErr || !newMsg) return { error: insErr?.message ?? 'insert failed' };

  const { error: enqErr } = await supa.rpc('enqueue_message', { p_message_id: newMsg.id });
  if (enqErr) return { error: enqErr.message };

  revalidatePath(`/alerts/${idParse.data}`);
  revalidatePath('/alerts');
  return { ok: true, reminded: targets.length, newMessageId: newMsg.id };
}
