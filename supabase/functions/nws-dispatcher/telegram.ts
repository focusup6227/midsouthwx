const TG_BASE = 'https://api.telegram.org';

// A Telegram inline-keyboard button is either a callback button (sends
// callback_data back to the bot) OR a URL button (opens the URL in the
// user's browser, no server round-trip). Each button has exactly one of
// the two — never both.
export type InlineKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export type SendMessageInput = {
  chat_id: number;
  text: string;
  reply_markup?: {
    inline_keyboard: InlineKeyboardButton[][];
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
