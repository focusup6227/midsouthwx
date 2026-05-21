// Thin Telegram Bot API wrapper. No SDK — Telegram's HTTP API is straightforward.

const TG_BASE = 'https://api.telegram.org';

export type QuickReply = { label: string; data: string };

export type SendMessageInput = {
  chat_id: number;
  text: string;
  parse_mode?: 'MarkdownV2' | 'HTML';
  reply_markup?: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  disable_web_page_preview?: boolean;
};

export class TelegramRateLimit extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`Telegram 429, retry after ${retryAfterSec}s`);
    this.retryAfterSec = retryAfterSec;
  }
}

export async function tgSendMessage(token: string, input: SendMessageInput) {
  const res = await fetch(`${TG_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) {
      const retry = body?.parameters?.retry_after ?? 1;
      throw new TelegramRateLimit(retry);
    }
    throw new Error(
      `Telegram ${res.status} ${res.statusText}: ${JSON.stringify(body)}`,
    );
  }
  return body.result as { message_id: number; chat: { id: number } };
}

export async function tgAnswerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
) {
  await fetch(`${TG_BASE}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export function mdToTelegramHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(md)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, '\n');
}

export function buildInlineKeyboard(quickReplies?: QuickReply[]) {
  if (!quickReplies?.length) return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < quickReplies.length; i += 2) {
    rows.push(
      quickReplies.slice(i, i + 2).map((q) => ({
        text: q.label,
        callback_data: q.data,
      })),
    );
  }
  return { inline_keyboard: rows };
}
