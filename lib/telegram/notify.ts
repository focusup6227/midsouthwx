// Tiny Telegram sendMessage wrapper for Next.js server contexts (server
// actions, route handlers). The edge functions have their own duplicated
// helper because they run on Deno; this is the Node twin so we don't pull
// the JSR Deno SDK into Vercel.

const TG_BASE = 'https://api.telegram.org';

/** Fire-and-forget DM to a subscriber. Failures are logged, not thrown —
 *  the calling server action shouldn't fail just because the bot got
 *  rate-limited or the chat was deleted. */
export async function sendTelegramDM(
  chatId: number | string,
  text: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[telegram-notify] TELEGRAM_BOT_TOKEN not set');
    return;
  }
  try {
    const res = await fetch(`${TG_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[telegram-notify] ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.error('[telegram-notify] fetch failed', e);
  }
}
