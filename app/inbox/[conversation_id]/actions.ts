'use server';

import { supabaseServer } from '@/lib/supabase/server';
import { telegramSendMessage } from '@/lib/telegram/send';
import { revalidatePath } from 'next/cache';

const MAX_BODY_LEN = 4096;

export async function markRead(convId: string) {
  const supa = supabaseServer();
  const { error } = await supa.rpc('mark_conversation_read', { conv_id: convId });
  if (error) throw new Error(error.message);
  revalidatePath('/inbox');
  revalidatePath(`/inbox/${convId}`);
}

export type SendThreadReplyResult =
  | { ok: true; replyId: string }
  | { ok: false; error: string };

export async function sendThreadReply(
  conversationId: string,
  body: string,
): Promise<SendThreadReplyResult> {
  const trimmed = body.trim();
  if (!trimmed) {
    return { ok: false, error: 'Message cannot be empty.' };
  }
  if (trimmed.length > MAX_BODY_LEN) {
    return { ok: false, error: 'Message is too long (max 4096 characters).' };
  }

  const supa = supabaseServer();
  const {
    data: { user },
    error: userErr,
  } = await supa.auth.getUser();
  if (userErr || !user) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data: convo, error: convoErr } = await supa
    .from('conversations')
    .select(
      'id, subscriber_id, subscribers(telegram_chat_id, status, display_name)',
    )
    .eq('id', conversationId)
    .single();

  if (convoErr || !convo) {
    return { ok: false, error: 'Conversation not found.' };
  }

  const sub = Array.isArray(convo.subscribers) ? convo.subscribers[0] : convo.subscribers;
  if (!sub?.telegram_chat_id) {
    return {
      ok: false,
      error: 'Subscriber has not linked Telegram yet. They must open the bot and tap Start.',
    };
  }

  if (sub.status === 'unsubscribed') {
    return { ok: false, error: 'Subscriber is unsubscribed. Cannot send messages.' };
  }
  if (sub.status === 'paused') {
    return { ok: false, error: 'Subscriber is paused. Unpause before replying.' };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, error: 'Telegram bot is not configured on the server.' };
  }

  const tg = await telegramSendMessage(token, sub.telegram_chat_id, trimmed);
  if (!tg.ok) {
    return { ok: false, error: tg.error };
  }

  const { data: replyId, error: recordErr } = await supa.rpc('record_conversation_outbound', {
    p_conversation_id: conversationId,
    p_body: trimmed,
    p_telegram_message_id: tg.messageId,
  });

  if (recordErr) {
    return {
      ok: false,
      error: `Sent on Telegram but failed to save: ${recordErr.message}`,
    };
  }

  revalidatePath('/inbox');
  revalidatePath(`/inbox/${conversationId}`);

  return { ok: true, replyId: String(replyId) };
}
