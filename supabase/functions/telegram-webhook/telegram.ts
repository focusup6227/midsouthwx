// Thin Telegram Bot API wrapper. No SDK — Telegram's HTTP API is straightforward.

const TG_BASE = 'https://api.telegram.org';

export type QuickReply = { label: string; data: string };

export type ReplyKeyboardMarkup = {
  keyboard: { text: string; request_location?: boolean }[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  one_time_keyboard?: boolean;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

export type ForceReplyMarkup = {
  force_reply: true;
  selective?: boolean;
  input_field_placeholder?: string;
};

export type SendMessageInput = {
  chat_id: number;
  text: string;
  parse_mode?: 'MarkdownV2' | 'HTML';
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ForceReplyMarkup;
  disable_web_page_preview?: boolean;
};

export type BotCommand = { command: string; description: string };

export async function tgSetMyCommands(token: string, commands: BotCommand[]) {
  const res = await fetch(`${TG_BASE}/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`setMyCommands failed: ${JSON.stringify(body)}`);
  }
}

/** Shows the "/" command menu on the button beside the message field. */
export async function tgSetChatMenuButtonCommands(token: string) {
  const res = await fetch(`${TG_BASE}/bot${token}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ menu_button: { type: 'commands' } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`setChatMenuButton failed: ${JSON.stringify(body)}`);
  }
}

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

/** Fetch the storage path for a Telegram file_id, then download the bytes.
 *  Telegram's getFile returns a relative file_path that expires after ~1h;
 *  the actual content lives at https://api.telegram.org/file/bot<token>/<path>.
 *  Returns the raw bytes + the resolved MIME (best-effort from the response
 *  header — Telegram doesn't echo back the original Content-Type from upload).
 */
export async function tgFetchFile(
  token: string,
  fileId: string,
): Promise<{ bytes: Uint8Array; mime: string; filePath: string }> {
  const metaRes = await fetch(`${TG_BASE}/bot${token}/getFile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.ok || !meta.result?.file_path) {
    throw new Error(`getFile failed: ${JSON.stringify(meta)}`);
  }
  const filePath: string = meta.result.file_path;
  const dlRes = await fetch(`${TG_BASE}/file/bot${token}/${filePath}`);
  if (!dlRes.ok) {
    throw new Error(`download failed: ${dlRes.status} ${dlRes.statusText}`);
  }
  const mime = dlRes.headers.get('content-type') ?? 'image/jpeg';
  const bytes = new Uint8Array(await dlRes.arrayBuffer());
  return { bytes, mime, filePath };
}

export async function tgAnswerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
  opts: { show_alert?: boolean } = {},
) {
  await fetch(`${TG_BASE}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: opts.show_alert,
    }),
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
