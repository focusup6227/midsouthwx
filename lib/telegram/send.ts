const TG_BASE = 'https://api.telegram.org';

export type TelegramSendResult =
  | { ok: true; messageId: number }
  | { ok: false; error: string; retryAfter?: number };

export async function telegramSendMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<TelegramSendResult> {
  const res = await fetch(`${TG_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = (await res.json()) as {
    ok?: boolean;
    description?: string;
    parameters?: { retry_after?: number };
    result?: { message_id?: number };
  };

  if (!res.ok || !data.ok) {
    const retryAfter = data.parameters?.retry_after;
    const desc = data.description ?? `Telegram HTTP ${res.status}`;
    return {
      ok: false,
      error: retryAfter ? `Rate limited — retry in ${retryAfter}s` : desc,
      retryAfter,
    };
  }

  const messageId = data.result?.message_id;
  if (messageId == null) {
    return { ok: false, error: 'Telegram returned no message_id' };
  }

  return { ok: true, messageId };
}
