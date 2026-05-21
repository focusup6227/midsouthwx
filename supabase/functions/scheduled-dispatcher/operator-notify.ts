import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

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

export async function notifyOperatorScheduledPending(
  supa: SupabaseClient,
  token: string,
  input: {
    messageId: string;
    recipientCount: number;
    bodyPreview: string;
    windowMinutes: number;
  },
): Promise<void> {
  const chatId = await operatorChatId(supa);
  if (!chatId) return;

  const preview = input.bodyPreview.slice(0, 200);
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text:
        `📅 Scheduled alert ready (${input.windowMinutes}m window)\n` +
        `${input.recipientCount} recipients\n\n${preview}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Send now', callback_data: `op:sched:approve:${input.messageId}` },
            { text: 'Skip', callback_data: `op:sched:skip:${input.messageId}` },
          ],
        ],
      },
    }),
  }).catch((e) => console.error('[operator-notify] scheduled pending', e));
}
