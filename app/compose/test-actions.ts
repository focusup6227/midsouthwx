'use server';

import { redirect } from 'next/navigation';
import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';

export type TestAlertResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

/** Send a "dry-run" alert that exercises the full pipeline (insert → enqueue
 *  → worker → Telegram → reply path) but targets ONLY the operator's own
 *  subscriber row. Requires the operator to also be a subscriber (linked by
 *  matching telegram_chat_id) — instructions returned if not.
 *
 *  Surfaced as the "Send test to me only" button on /compose. */
export async function sendTestAlert(input: {
  body_md: string;
  media?: { url: string; type: 'animation' | 'photo' | 'video' | 'document' } | null;
}): Promise<TestAlertResult> {
  const body = (input.body_md ?? '').trim();
  if (!body) return { ok: false, error: 'Body cannot be empty.' };

  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return { ok: false, error: 'not authenticated' };

  const { data: op } = await supa
    .from('operators')
    .select('telegram_chat_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!op) return { ok: false, error: 'operators only' };
  if (!op.telegram_chat_id) {
    return {
      ok: false,
      error:
        'Your operator row has no telegram_chat_id. Link your Telegram account first (Settings → Telegram).',
    };
  }

  // Find the matching subscriber row so the queue + worker treat this as a
  // real fan-out.
  const admin = supabaseAdmin();
  const { data: sub } = await admin
    .from('subscribers')
    .select('id, status')
    .eq('telegram_chat_id', op.telegram_chat_id)
    .maybeSingle();
  if (!sub) {
    return {
      ok: false,
      error:
        "I don't see a subscriber row matching your Telegram chat. Sign up via the /signup page (your own bot link), then try again — your operator account stays separate from the subscriber row used for testing.",
    };
  }
  if (sub.status !== 'active') {
    return {
      ok: false,
      error:
        `Your subscriber row is status='${sub.status}'. Use /resume in the bot to re-activate it before testing.`,
    };
  }

  const { data: msg, error: insertErr } = await admin
    .from('messages')
    .insert({
      body_md: `[TEST] ${body}`,
      body_rendered: `[TEST] ${body}`,
      source: 'manual',
      status: 'draft',
      audience_spec: { subscribers: [sub.id] },
      quick_replies: null,
      created_by: userId,
      media_url: input.media?.url ?? null,
      media_type: input.media?.type ?? null,
    })
    .select('id')
    .single();
  if (insertErr || !msg) return { ok: false, error: insertErr?.message ?? 'insert failed' };

  const { error: enqErr } = await admin.rpc('enqueue_message_system', { p_message_id: msg.id });
  if (enqErr) {
    await admin.from('messages').update({ status: 'failed' }).eq('id', msg.id);
    return { ok: false, error: enqErr.message };
  }

  return { ok: true, messageId: msg.id };
}

export async function sendTestAlertAndRedirect(input: Parameters<typeof sendTestAlert>[0]): Promise<never> {
  const res = await sendTestAlert(input);
  if (!res.ok) throw new Error(res.error);
  redirect(`/alerts/${res.messageId}`);
}
