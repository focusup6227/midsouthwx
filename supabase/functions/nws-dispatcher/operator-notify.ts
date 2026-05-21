import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { tgSendMessage } from './telegram.ts';

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
