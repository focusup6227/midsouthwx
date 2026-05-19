// Outbound send worker. Called by pg_cron every minute (and may be invoked
// ad-hoc by a server action immediately after queueing a message).
//
// Behavior:
//   1. Claim up to BATCH pending rows with FOR UPDATE SKIP LOCKED.
//   2. Send to Telegram, respecting ~25 msg/s across distinct chats.
//   3. On 429, sleep retry_after, requeue remainder.
//   4. On 5xx / network error, increment attempts; mark 'failed' after 5.
//   5. Update outbound_queue + delivery_logs + messages.status.
//
// Idempotency: BATCH is bounded, locks expire if function dies, attempts
// counter prevents infinite retry.

import { serviceClient, json } from './_shared/supabase.ts';
import {
  buildInlineKeyboard,
  mdToTelegramHtml,
  TelegramRateLimit,
  tgSendMessage,
  type QuickReply,
} from './_shared/telegram.ts';

const BATCH = 200;          // rows per cron tick
const RATE_PER_SEC = 25;    // safely under Telegram's 30/s
const MAX_ATTEMPTS = 5;
const LOCK_TTL_SEC = 60;

type ClaimedRow = {
  id: number;
  message_id: string;
  subscriber_id: string;
  attempts: number;
  body_rendered: string;
  quick_replies: QuickReply[] | null;
  telegram_chat_id: number;
};

async function claimBatch(supa: ReturnType<typeof serviceClient>) {
  // Use a CTE update to atomically claim a batch.
  const lockedBy = `worker-${crypto.randomUUID()}`;
  const { data, error } = await supa.rpc('claim_outbound_batch', {
    p_limit: BATCH,
    p_locked_by: lockedBy,
    p_lock_ttl_sec: LOCK_TTL_SEC,
  });
  if (error) {
    console.error('claim_outbound_batch failed', error);
    return [] as ClaimedRow[];
  }
  return (data ?? []) as ClaimedRow[];
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

Deno.serve(async (req) => {
  // Both pg_cron (auth header) and manual triggers from the dashboard reach here.
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ ok: false }, 405);
  }

  const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!tgToken) return json({ ok: false, error: 'bot token missing' }, 500);

  const supa = serviceClient();
  const rows = await claimBatch(supa);
  if (!rows.length) return json({ ok: true, sent: 0, claimed: 0 });

  const intervalMs = Math.floor(1000 / RATE_PER_SEC);
  let sent = 0;
  let failed = 0;
  const touchedMessages = new Set<string>();

  for (const row of rows) {
    touchedMessages.add(row.message_id);

    try {
      const result = await tgSendMessage(tgToken, {
        chat_id: row.telegram_chat_id,
        text: mdToTelegramHtml(row.body_rendered),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildInlineKeyboard(row.quick_replies ?? undefined),
      });

      await supa
        .from('outbound_queue')
        .update({
          status: 'sent',
          telegram_message_id: result.message_id,
          sent_at: new Date().toISOString(),
          last_error: null,
          locked_at: null,
          locked_by: null,
        })
        .eq('id', row.id);

      await supa.from('delivery_logs').insert({
        outbound_id: row.id,
        message_id: row.message_id,
        subscriber_id: row.subscriber_id,
        event: 'sent',
        meta: { telegram_message_id: result.message_id },
      });

      sent++;
    } catch (e) {
      if (e instanceof TelegramRateLimit) {
        // Release this row + remaining rows so the next tick picks them up.
        const remainingIds = rows
          .slice(rows.indexOf(row))
          .map((r) => r.id);
        await supa
          .from('outbound_queue')
          .update({
            status: 'pending',
            locked_at: null,
            locked_by: null,
            send_after: new Date(Date.now() + e.retryAfterSec * 1000).toISOString(),
          })
          .in('id', remainingIds);
        await sleep(e.retryAfterSec * 1000);
        break;
      }

      const attempts = row.attempts + 1;
      const isFinal = attempts >= MAX_ATTEMPTS;
      await supa
        .from('outbound_queue')
        .update({
          status: isFinal ? 'failed' : 'pending',
          attempts,
          last_error: String(e).slice(0, 500),
          locked_at: null,
          locked_by: null,
          send_after: new Date(Date.now() + attempts * 30_000).toISOString(),
        })
        .eq('id', row.id);

      await supa.from('delivery_logs').insert({
        outbound_id: row.id,
        message_id: row.message_id,
        subscriber_id: row.subscriber_id,
        event: 'failed',
        meta: { error: String(e), attempts },
      });
      failed++;
    }

    await sleep(intervalMs);
  }

  // Roll up message status: if no remaining pending/sending rows for a message, mark sent.
  for (const mid of touchedMessages) {
    const { count } = await supa
      .from('outbound_queue')
      .select('*', { count: 'exact', head: true })
      .eq('message_id', mid)
      .in('status', ['pending', 'sending']);
    if ((count ?? 0) === 0) {
      await supa
        .from('messages')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', mid)
        .neq('status', 'sent');
    } else {
      await supa
        .from('messages')
        .update({ status: 'sending' })
        .eq('id', mid)
        .eq('status', 'queued');
    }
  }

  return json({ ok: true, claimed: rows.length, sent, failed });
});
