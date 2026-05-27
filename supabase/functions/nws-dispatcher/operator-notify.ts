import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { tgSendMessage } from './telegram.ts';

/** Fire an urgent push to the operator's Telegram for tornado warnings and
 *  emergencies. Decoupled from the regular dispatch path so the operator is
 *  alerted even when no auto-rule matches (status='skipped') and even when an
 *  auto-rule fires (status='dispatched'). Idempotency: the caller already
 *  claimed the right to notify via an atomic UPDATE on operator_alerted_at,
 *  so this function trusts that and just sends. */
export async function notifyOperatorTornado(
  supa: SupabaseClient,
  token: string,
  alert: {
    id: string;
    nws_id?: string | null;
    event: string;
    headline: string | null;
    area_desc: string | null;
    severity: string | null;
    expires_at: string | null;
  },
): Promise<void> {
  const chatId = await operatorChatId(supa);
  if (!chatId) return;

  const isEmergency = /tornado emergency/i.test(alert.event);
  const sigil = isEmergency ? '🚨🌪️ TORNADO EMERGENCY' : '🌪️ TORNADO WARNING';
  const expires = alert.expires_at
    ? new Date(alert.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '—';
  const body = [
    sigil,
    alert.headline ?? alert.event,
    `Area: ${alert.area_desc ?? '—'}`,
    `Until: ${expires}`,
    `Severity: ${alert.severity ?? '—'}`,
  ].join('\n');

  // URL button → opens the operator's /nws/<alert.id> page in the browser.
  // Previously a callback_data button that no handler matched, so it acked
  // with a generic "got it" reply instead of taking the operator anywhere.
  const site = Deno.env.get('PUBLIC_SITE_URL')?.replace(/\/$/, '');
  const detailUrl = site ? `${site}/nws/${alert.id}` : null;

  await tgSendMessage(token, {
    chat_id: chatId,
    text: body,
    reply_markup: detailUrl
      ? {
          inline_keyboard: [[
            { text: 'Open full alert details', url: detailUrl },
          ]],
        }
      : undefined,
  });
}

async function operatorChatId(supa: SupabaseClient): Promise<number> {
  const fromEnv = Number(Deno.env.get('OPERATOR_TELEGRAM_CHAT_ID') ?? 0);
  if (fromEnv) return fromEnv;

  const { data: ops } = await supa
    .from('operators')
    .select('telegram_chat_id')
    .not('telegram_chat_id', 'is', null)
    .limit(1);

  const id = ops?.[0]?.telegram_chat_id;
  return id ? Number(id) : 0;
}

export async function notifyOperatorNwsPending(
  supa: SupabaseClient,
  token: string,
  input: {
    messageId: string;
    event: string;
    headline: string | null;
    recipientCount: number;
    bodyPreview: string;
  },
): Promise<void> {
  const chatId = await operatorChatId(supa);
  if (!chatId) return;

  const preview = input.bodyPreview.slice(0, 200);
  await tgSendMessage(token, {
    chat_id: chatId,
    text:
      `🌩 NWS alert needs approval\n` +
      `${input.event}${input.headline ? ` · ${input.headline}` : ''}\n` +
      `${input.recipientCount} recipients\n\n${preview}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Approve & send', callback_data: `op:nws:approve:${input.messageId}` },
          { text: 'Reject', callback_data: `op:nws:reject:${input.messageId}` },
        ],
      ],
    },
  });
}
