// Telegram webhook. Receives every update from the bot:
//   - /start <link_token>   → claim a pending subscriber row
//   - /unsubscribe          → flip status
//   - location share        → update lat/lng
//   - text message          → insert into replies + conversation
//   - callback_query        → record check-in response + reply, ack the button
// We verify the X-Telegram-Bot-Api-Secret-Token header (set when registering
// the webhook with setWebhook) — Telegram does not sign requests otherwise.

import { serviceClient, json } from './supabase.ts';
import { tgAnswerCallbackQuery, tgSendMessage } from './telegram.ts';
import { notifyExternalEndpointsForMessage } from './external-notify.ts';
import {
  advanceScheduleAfterSend,
  scheduleMetaFromAudience,
} from './schedule-helpers.ts';
import {
  DEFAULT_ALERT_PREFERENCES,
  DEFAULT_QUIET_HOURS,
  formatPrefsSummary,
  parseAlertPreferences,
  parseQuietHours,
  prefsKeyboard,
} from './subscriber-prefs.ts';

// Same as secret name TELEGRAM_WEBHOOK_SECRET; parts joined so upload/bundle cannot break one long literal.
const TELEGRAM_WEBHOOK_SECRET_KEY = ['TELEGRAM', 'WEBHOOK', 'SECRET'].join('_');

const DISTRESS_KEYWORDS = [
  '911',
  'emergency',
  'help',
  'trapped',
  'stuck',
  'stranded',
  'injured',
  'bleeding',
  'fire',
  'flood',
  'flooding',
  'water rising',
  'collapsed',
  'cant breathe',
  "can't breathe",
  'unconscious',
  'tornado here',
  'tree on house',
  'tree fell',
  'need rescue',
  'rescue',
];

function distressKeywordMatch(text: string, keyword: string): boolean {
  if (keyword.includes(' ') || keyword.includes("'")) {
    return text.includes(keyword);
  }
  const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(text);
}

function looksLikeDistress(text: string | undefined) {
  if (!text) return false;
  const t = text.toLowerCase();
  return DISTRESS_KEYWORDS.some((k) => distressKeywordMatch(t, k));
}

async function operatorChatId(supa: ReturnType<typeof serviceClient>): Promise<number> {
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

const OP_CALLBACK = /^op:(nws|sched):(approve|reject|skip):([0-9a-f-]{36})$/i;

async function handleOperatorCallback(
  supa: ReturnType<typeof serviceClient>,
  token: string,
  chatId: number,
  cqId: string,
  data: string,
): Promise<boolean> {
  const opChat = await operatorChatId(supa);
  if (!opChat || chatId !== opChat) return false;

  const m = OP_CALLBACK.exec(data);
  if (!m) return false;

  const [, kind, action, messageId] = m;
  const isApprove = action === 'approve';
  const isReject = action === 'reject' || action === 'skip';

  const { data: msg, error: fetchErr } = await supa
    .from('messages')
    .select('id, source, status, audience_spec')
    .eq('id', messageId)
    .single();

  if (fetchErr || !msg || msg.status !== 'pending_approval') {
    await tgAnswerCallbackQuery(token, cqId, 'Message not found or already handled.');
    return true;
  }

  if (kind === 'nws') {
    if (msg.source !== 'nws') {
      await tgAnswerCallbackQuery(token, cqId, 'Not an NWS pending message.');
      return true;
    }
    if (isReject) {
      await supa.from('messages').update({ status: 'cancelled' }).eq('id', messageId);
      await tgAnswerCallbackQuery(token, cqId, 'NWS alert rejected.');
      return true;
    }
    const { error: enqErr } = await supa.rpc('enqueue_message_system', { p_message_id: messageId });
    if (enqErr) {
      await tgAnswerCallbackQuery(token, cqId, `Enqueue failed: ${enqErr.message}`);
      return true;
    }
    notifyExternalEndpointsForMessage(supa, messageId).catch(console.error);
    await tgAnswerCallbackQuery(token, cqId, 'Approved — sending now.');
    return true;
  }

  if (kind === 'sched') {
    if (msg.source !== 'scheduled') {
      await tgAnswerCallbackQuery(token, cqId, 'Not a scheduled pending message.');
      return true;
    }
    const meta = scheduleMetaFromAudience(msg.audience_spec as Record<string, unknown>);
    if (isReject) {
      await supa.from('messages').update({ status: 'cancelled' }).eq('id', messageId);
      if (meta) {
        await advanceScheduleAfterSend(
          supa,
          meta.scheduled_message_id,
          meta.rrule,
          meta.fired_at,
        );
      }
      await tgAnswerCallbackQuery(token, cqId, 'Scheduled alert skipped.');
      return true;
    }
    const { error: enqErr } = await supa.rpc('enqueue_message_system', { p_message_id: messageId });
    if (enqErr) {
      await tgAnswerCallbackQuery(token, cqId, `Enqueue failed: ${enqErr.message}`);
      return true;
    }
    notifyExternalEndpointsForMessage(supa, messageId).catch(console.error);
    if (meta) {
      await advanceScheduleAfterSend(
        supa,
        meta.scheduled_message_id,
        meta.rrule,
        meta.fired_at,
      );
    }
    await tgAnswerCallbackQuery(token, cqId, 'Approved — sending now.');
    return true;
  }

  return false;
}

const PREF_TOGGLE = /^pref:toggle:(warnings|watches|advisories|statements|quiet)$/;

async function sendPrefsMenu(
  token: string,
  chatId: number,
  prefs: ReturnType<typeof parseAlertPreferences>,
  qh: ReturnType<typeof parseQuietHours>,
) {
  await tgSendMessage(token, {
    chat_id: chatId,
    text: formatPrefsSummary(prefs, qh),
    reply_markup: prefsKeyboard(prefs, qh),
  });
}

async function handlePrefCallback(
  supa: ReturnType<typeof serviceClient>,
  token: string,
  chatId: number,
  cqId: string,
  data: string,
): Promise<boolean> {
  const m = PREF_TOGGLE.exec(data);
  if (!m) return false;

  const field = m[1];
  const { data: sub, error } = await supa
    .from('subscribers')
    .select('id, alert_preferences, quiet_hours')
    .eq('telegram_chat_id', chatId)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !sub) {
    await tgAnswerCallbackQuery(token, cqId, 'Sign up first to manage preferences.');
    return true;
  }

  const prefs = parseAlertPreferences(sub.alert_preferences);
  const qh = parseQuietHours(sub.quiet_hours);

  if (field === 'quiet') {
    qh.enabled = !qh.enabled;
    if (qh.enabled && !sub.quiet_hours) {
      qh.start = DEFAULT_QUIET_HOURS.start;
      qh.end = DEFAULT_QUIET_HOURS.end;
      qh.timezone = DEFAULT_QUIET_HOURS.timezone;
    }
    await supa
      .from('subscribers')
      .update({ quiet_hours: qh, updated_at: new Date().toISOString() })
      .eq('id', sub.id);
  } else {
    const key = field as keyof typeof prefs;
    prefs[key] = !prefs[key];
    await supa
      .from('subscribers')
      .update({ alert_preferences: prefs, updated_at: new Date().toISOString() })
      .eq('id', sub.id);
  }

  await tgAnswerCallbackQuery(token, cqId, 'Updated.');
  await sendPrefsMenu(token, chatId, prefs, qh);
  return true;
}

async function showPrefsForChat(
  supa: ReturnType<typeof serviceClient>,
  token: string,
  chatId: number,
) {
  const { data: sub } = await supa
    .from('subscribers')
    .select('alert_preferences, quiet_hours')
    .eq('telegram_chat_id', chatId)
    .eq('status', 'active')
    .maybeSingle();

  if (!sub) {
    await tgSendMessage(token, {
      chat_id: chatId,
      text: 'You need to finish sign-up before changing preferences. Use the link from the website.',
    });
    return;
  }

  await sendPrefsMenu(
    token,
    chatId,
    parseAlertPreferences(sub.alert_preferences ?? DEFAULT_ALERT_PREFERENCES),
    parseQuietHours(sub.quiet_hours),
  );
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false }, 405);

  const expected = Deno.env.get(TELEGRAM_WEBHOOK_SECRET_KEY);
  const got = req.headers.get('x-telegram-bot-api-secret-token');
  if (!expected || got !== expected) {
    return json({ ok: false, error: 'bad webhook secret' }, 401);
  }

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return json({ ok: false, error: 'bot token missing' }, 500);

  let update: any;
  try {
    update = await req.json();
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }

  const supa = serviceClient();

  try {
    // ── callback_query (inline keyboard tap) ─────────────────────────────
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId: number = cq.message?.chat?.id;
      const cqId: string = cq.id;
      const data: string = cq.data ?? '';

      if (await handleOperatorCallback(supa, token, chatId, cqId, data)) {
        return json({ ok: true });
      }

      if (await handlePrefCallback(supa, token, chatId, cqId, data)) {
        return json({ ok: true });
      }

      // Find the subscriber
      const { data: sub } = await supa
        .from('subscribers')
        .select('id')
        .eq('telegram_chat_id', chatId)
        .maybeSingle();

      if (sub) {
        // Best-effort: associate with the most recent message sent to them.
        const { data: lastQ } = await supa
          .from('outbound_queue')
          .select('message_id')
          .eq('subscriber_id', sub.id)
          .eq('status', 'sent')
          .order('sent_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const message_id = lastQ?.message_id ?? null;

        if (message_id) {
          await supa.from('check_in_responses').upsert(
            {
              message_id,
              subscriber_id: sub.id,
              response_code: data,
              responded_at: new Date().toISOString(),
            },
            { onConflict: 'message_id,subscriber_id' },
          );
        }

        // Mirror as a reply so it shows in the inbox feed too.
        const { data: conv } = await supa
          .from('conversations')
          .upsert(
            {
              subscriber_id: sub.id,
              last_message_at: new Date().toISOString(),
            },
            { onConflict: 'subscriber_id' },
          )
          .select('id')
          .single();

        if (conv) {
          await supa.from('replies').insert({
            conversation_id: conv.id,
            subscriber_id: sub.id,
            parent_message_id: message_id,
            callback_data: data,
            body: `[button] ${data}`,
            telegram_message_id: cq.message?.message_id ?? null,
            is_distress: data === 'help',
          });
          await supa.rpc('increment_unread', { conv_id: conv.id }).then(
            () => {},
            () => {/* fn may not exist yet; ignore */},
          );
        }
      }

      await tgAnswerCallbackQuery(token, cqId, 'Got it — thanks.');
      return json({ ok: true });
    }

    // ── regular message ────────────────────────────────────────────────
    const msg = update.message;
    if (!msg) return json({ ok: true });
    const chatId: number = msg.chat?.id;
    const tgUsername: string | undefined = msg.from?.username;
    const text: string | undefined = msg.text;

    // /start <link_token> handshake
    if (text?.startsWith('/start')) {
      const parts = text.split(/\s+/);
      const linkToken = parts[1];
      if (!linkToken) {
        await tgSendMessage(token, {
          chat_id: chatId,
          text:
            'Welcome to Mid-South WX. To finish signing up, sign up on the website first — you will get a link that brings you back here.',
        });
        return json({ ok: true });
      }

      const { data: pending } = await supa
        .from('subscribers')
        .select('id, status, link_expires_at')
        .eq('link_token', linkToken)
        .maybeSingle();

      if (!pending) {
        await tgSendMessage(token, {
          chat_id: chatId,
          text:
            'That sign-up link is not recognized. Please sign up again on the website.',
        });
        return json({ ok: true });
      }

      if (
        pending.link_expires_at &&
        new Date(pending.link_expires_at) < new Date()
      ) {
        await tgSendMessage(token, {
          chat_id: chatId,
          text: 'That sign-up link has expired. Please sign up again on the website.',
        });
        return json({ ok: true });
      }

      await supa
        .from('subscribers')
        .update({
          status: 'active',
          telegram_chat_id: chatId,
          telegram_username: tgUsername ?? null,
          link_token: null,
          link_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', pending.id);

      await supa
        .from('conversations')
        .upsert({ subscriber_id: pending.id }, { onConflict: 'subscriber_id' });

      await tgSendMessage(token, {
        chat_id: chatId,
        text:
          'You are signed up for Mid-South WX alerts.\n\n' +
          '• Send `/prefs` to choose warnings vs watches, advisories, and quiet hours.\n' +
          '• If you are not home during severe weather, send `/where <address>` so we know where to send help.\n' +
          '• Send `/home` to clear your current-location override.\n' +
          '• Reply STOP or send /unsubscribe to opt out.',
      });
      return json({ ok: true });
    }

    // /where <address> — update current address (when subscriber isn't home)
    if (text?.startsWith('/where') || text?.startsWith('/here')) {
      const address = text.replace(/^\/(where|here)\s*/, '').trim();
      if (!address) {
        await tgSendMessage(token, {
          chat_id: chatId,
          text:
            'Send `/where` followed by an address, e.g. `/where 123 Main St, Memphis TN`. ' +
            'This tells the operator where you are if you signal distress.',
        });
        return json({ ok: true });
      }
      const { error: updErr } = await supa
        .from('subscribers')
        .update({
          current_address: address,
          current_address_updated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('telegram_chat_id', chatId);
      if (updErr) {
        await tgSendMessage(token, {
          chat_id: chatId,
          text: 'Could not update your location. Are you signed up? Try /start.',
        });
        return json({ ok: true });
      }
      await tgSendMessage(token, {
        chat_id: chatId,
        text:
          `Got it. We have you at:\n${address}\n\n` +
          'Send /home when you are back at your home address.',
      });
      return json({ ok: true });
    }

    // /home — clear current-address override (back at home)
    if (text === '/prefs' || text?.startsWith('/prefs ')) {
      await showPrefsForChat(supa, token, chatId);
      return json({ ok: true });
    }

    if (text === '/home') {
      await supa
        .from('subscribers')
        .update({
          current_address: null,
          current_address_updated_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('telegram_chat_id', chatId);
      await tgSendMessage(token, {
        chat_id: chatId,
        text: 'Cleared. We will assume you are at your home address.',
      });
      return json({ ok: true });
    }

    if (text === '/unsubscribe' || /^stop$/i.test(text || '')) {
      await supa
        .from('subscribers')
        .update({ status: 'unsubscribed', updated_at: new Date().toISOString() })
        .eq('telegram_chat_id', chatId);
      await tgSendMessage(token, {
        chat_id: chatId,
        text: 'You are unsubscribed from Mid-South WX. Send /start again to re-enable (a new sign-up link is required).',
      });
      return json({ ok: true });
    }

    // Location share — update the subscriber's geometry
    if (msg.location) {
      const { latitude, longitude } = msg.location;
      await supa
        .from('subscribers')
        .update({
          location: `SRID=4326;POINT(${longitude} ${latitude})`,
          updated_at: new Date().toISOString(),
        })
        .eq('telegram_chat_id', chatId);
      await tgSendMessage(token, {
        chat_id: chatId,
        text: 'Location updated. You will now receive alerts based on your precise position.',
      });
      return json({ ok: true });
    }

    // Free-text inbound → reply in inbox
    const { data: sub } = await supa
      .from('subscribers')
      .select('id')
      .eq('telegram_chat_id', chatId)
      .maybeSingle();

    if (!sub) {
      await tgSendMessage(token, {
        chat_id: chatId,
        text:
          'I do not have you on file. Please sign up on the website first; you will get a link that brings you back here.',
      });
      return json({ ok: true });
    }

    const { data: conv } = await supa
      .from('conversations')
      .upsert(
        {
          subscriber_id: sub.id,
          last_message_at: new Date().toISOString(),
        },
        { onConflict: 'subscriber_id' },
      )
      .select('id')
      .single();

    if (!conv) return json({ ok: true });

    const parent_message_id = msg.reply_to_message
      ? // We do not have a clean way to map reply_to_message → our message UUID
        // without storing telegram_message_id on outbound_queue. Skip for v1
        // and rely on recency-based threading in the dashboard.
        null
      : null;

    await supa.from('replies').insert({
      conversation_id: conv.id,
      subscriber_id: sub.id,
      parent_message_id,
      body: text ?? null,
      telegram_message_id: msg.message_id,
      is_distress: looksLikeDistress(text),
    });

    // Self-notify operator on distress keywords.
    if (looksLikeDistress(text)) {
      const opChatId = Number(Deno.env.get('OPERATOR_TELEGRAM_CHAT_ID') ?? 0);
      if (opChatId) {
        await tgSendMessage(token, {
          chat_id: opChatId,
          text: `⚠️ Distress keyword from a subscriber: "${(text ?? '').slice(0, 200)}"`,
        });
      }
    }

    return json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
