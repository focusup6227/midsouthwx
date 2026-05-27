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
  return tgPost(token, 'sendMessage', input);
}

export type SendMediaInput = {
  chat_id: number;
  caption?: string;
  parse_mode?: 'MarkdownV2' | 'HTML';
  reply_markup?: SendMessageInput['reply_markup'];
  url: string;
  /** animation = GIFs / soundless MP4; photo = jpg/png/webp; video = mp4 */
  kind: 'animation' | 'photo' | 'video' | 'document';
};

/** Send a media message (GIF/photo/video/document). We fetch the bytes from
 *  storage and multipart-upload to Telegram instead of letting Telegram fetch
 *  the URL server-side — the URL path caps animations/video/document at 20 MB
 *  (5 MB for photos) and also surfaces opaque "wrong type of the web page
 *  content" errors when their fetcher times out. Multipart raises the cap to
 *  50 MB at the cost of one extra hop through the worker. */
export async function tgSendMedia(token: string, input: SendMediaInput) {
  const method = {
    animation: 'sendAnimation',
    photo: 'sendPhoto',
    video: 'sendVideo',
    document: 'sendDocument',
  }[input.kind];
  const fileField = {
    animation: 'animation',
    photo: 'photo',
    video: 'video',
    document: 'document',
  }[input.kind];

  // 30s cap on the storage fetch — a hung storage round-trip would otherwise
  // pin a worker slot indefinitely and starve the rest of the batch. 50 MB at
  // even a few Mbps fits comfortably inside this window.
  const mediaRes = await fetch(input.url, { signal: AbortSignal.timeout(30_000) });
  if (!mediaRes.ok) {
    throw new Error(`failed to fetch media URL ${input.url}: ${mediaRes.status} ${mediaRes.statusText}`);
  }
  const mediaBlob = await mediaRes.blob();
  // Telegram uses the filename to infer extension. Strip query string and any
  // leading path so the bot API sees a clean name. Fall back to a sensible
  // default per-kind so untyped URLs still upload.
  const fallbackExt = { animation: 'gif', photo: 'jpg', video: 'mp4', document: 'bin' }[input.kind];
  const filename = input.url.split('?')[0].split('/').pop() || `media.${fallbackExt}`;

  const form = new FormData();
  form.set('chat_id', String(input.chat_id));
  form.set(fileField, mediaBlob, filename);
  if (input.caption) form.set('caption', input.caption);
  if (input.parse_mode) form.set('parse_mode', input.parse_mode);
  if (input.reply_markup) form.set('reply_markup', JSON.stringify(input.reply_markup));

  const res = await fetch(`${TG_BASE}/bot${token}/${method}`, {
    method: 'POST',
    body: form,
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

async function tgPost(token: string, method: string, payload: unknown) {
  const res = await fetch(`${TG_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
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

// Render the operator-authored markdown into the subset Telegram accepts.
// We send as plain HTML to dodge MarkdownV2's escaping quirks.
export function mdToTelegramHtml(md: string): string {
  // Minimal: bold **x**, italic *x*, code `x`, links [t](u). Escape HTML first.
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
  // 2 columns max for thumb-friendly tapping
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
