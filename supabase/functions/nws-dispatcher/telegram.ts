const TG_BASE = 'https://api.telegram.org';

export type SendMessageInput = {
  chat_id: number;
  text: string;
  reply_markup?: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
};

export async function tgSendMessage(token: string, input: SendMessageInput) {
  const res = await fetch(`${TG_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Telegram ${res.status}: ${JSON.stringify(body)}`);
  }
  return body.result;
}
