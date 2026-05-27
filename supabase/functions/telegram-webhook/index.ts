// Telegram webhook. Receives every update from the bot:
//   - /start <link_token>   → claim a pending subscriber row
//   - /help, /prefs, menu buttons → command list + preferences
//   - /unsubscribe          → flip status
//   - location share        → update lat/lng
//   - text message          → insert into replies + conversation
//   - callback_query        → record check-in response + reply, ack the button
// We verify the X-Telegram-Bot-Api-Secret-Token header (set when registering
// the webhook with setWebhook) — Telegram does not sign requests otherwise.

import { serviceClient, json } from './supabase.ts';
import {
  commandsHelpText,
  hazardLabel,
  helpInlineKeyboard,
  isCommandsMenuText,
  isHelpMenuText,
  isLocationMenuText,
  isPrefsMenuText,
  isStatusMenuText,
  locationInlineKeyboard,
  parseCmdCallback,
  reportHazardKeyboard,
  subscriberReplyKeyboard,
  SUBSCRIBER_BOT_COMMANDS,
} from './bot-commands.ts';
import { clearAwaiting, getAwaiting, setAwaiting } from './state.ts';
import {
  tgAnswerCallbackQuery,
  tgFetchFile,
  tgSendMessage,
  tgSetChatMenuButtonCommands,
  tgSetMyCommands,
} from './telegram.ts';
import { notifyExternalEndpointsForMessage } from './external-notify.ts';
import { geocodeAddress } from './geocode.ts';
import {
  advanceScheduleAfterSend,
  scheduleMetaFromAudience,
} from './schedule-helpers.ts';
import {
  DEFAULT_ALERT_PREFERENCES,
  DEFAULT_QUIET_HOURS,
  HAZARD_KINDS,
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

const PREF_TOGGLE = /^pref:toggle:(warnings|watches|advisories|statements|quiet|aggregate)$/;
// F6: hazard-specific opt-out. Kept separate from PREF_TOGGLE so the existing
// boolean-toggle path doesn't have to special-case array membership.
const PREF_HAZARD = /^pref:hazard:(tornado|severe|flood|winter|heat|wind)$/;

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
  const mToggle = PREF_TOGGLE.exec(data);
  const mHazard = PREF_HAZARD.exec(data);
  if (!mToggle && !mHazard) return false;

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

  if (mHazard) {
    // F6: toggle hazard membership in skip_hazards. Present → remove, absent
    // → add. The SQL gate (subscriber_wants_nws_event) reads the same array
    // on the next NWS fan-out.
    const kind = mHazard[1] as typeof HAZARD_KINDS[number];
    const i = prefs.skip_hazards.indexOf(kind);
    if (i >= 0) prefs.skip_hazards.splice(i, 1);
    else prefs.skip_hazards.push(kind);
    await supa
      .from('subscribers')
      .update({ alert_preferences: prefs, updated_at: new Date().toISOString() })
      .eq('id', sub.id);
  } else if (mToggle) {
    const field = mToggle[1];
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
    } else if (field === 'aggregate') {
      // Outbreak grouping opt-out — read by aggregation.ts in the send worker
      // (subscriberWantsAggregation). Stored under the same alert_preferences
      // jsonb as the category toggles.
      prefs.aggregate_warnings = !prefs.aggregate_warnings;
      await supa
        .from('subscribers')
        .update({ alert_preferences: prefs, updated_at: new Date().toISOString() })
        .eq('id', sub.id);
    } else {
      const key = field as 'warnings' | 'watches' | 'advisories' | 'statements';
      prefs[key] = !prefs[key];
      await supa
        .from('subscribers')
        .update({ alert_preferences: prefs, updated_at: new Date().toISOString() })
        .eq('id', sub.id);
    }
  }

  await tgAnswerCallbackQuery(token, cqId, 'Updated.');
  await sendPrefsMenu(token, chatId, prefs, qh);
  return true;
}

async function sendCommandsHelp(token: string, chatId: number) {
  await tgSendMessage(token, {
    chat_id: chatId,
    text: commandsHelpText(),
    reply_markup: helpInlineKeyboard(),
  });
  // Reply keyboard cannot share a message with inline buttons — send separately so
  // existing subscribers get the 📋 / ⚙️ / 📍 buttons below the input field.
  await tgSendMessage(token, {
    chat_id: chatId,
    text: '⌨️ Quick buttons are below the message box.',
    reply_markup: subscriberReplyKeyboard(),
  });
}

async function handleSubscriberCmdCallback(
  supa: ReturnType<typeof serviceClient>,
  token: string,
  chatId: number,
  cqId: string,
  cmd: string,
): Promise<boolean> {
  if (cmd === 'help') {
    await tgAnswerCallbackQuery(token, cqId);
    await sendCommandsHelp(token, chatId);
    return true;
  }
  if (cmd === 'prefs') {
    await tgAnswerCallbackQuery(token, cqId);
    await showPrefsForChat(supa, token, chatId);
    return true;
  }
  if (cmd === 'where_help') {
    await tgAnswerCallbackQuery(token, cqId);
    await tgSendMessage(token, {
      chat_id: chatId,
      text:
        'Send `/where` followed by your address, e.g.:\n`/where 123 Main St, Memphis TN`\n\n' +
        'Use this when you are not home during severe weather.',
    });
    return true;
  }
  if (cmd === 'home') {
    await supa
      .from('subscribers')
      .update({
        current_address: null,
        current_address_updated_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('telegram_chat_id', chatId);
    await tgAnswerCallbackQuery(token, cqId, 'Home location restored.');
    await tgSendMessage(token, {
      chat_id: chatId,
      text: 'Cleared. We will assume you are at your home address.',
    });
    return true;
  }
  return false;
}

/** Parse "for 24h" / "for 2 days" / "for 3 hours" trailing on a /where input.
 *  Returns hours (rounded to int) or null if no TTL was specified. */
function parseTtlHours(raw: string): { address: string; ttlHours: number | null } {
  const m = raw.match(/^(.*?)\s+for\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|d|day|days)\s*$/i);
  if (!m) return { address: raw, ttlHours: null };
  const n = parseFloat(m[2]);
  const unit = m[3].toLowerCase();
  const isDays = unit.startsWith('d');
  return { address: m[1].trim(), ttlHours: Math.round(isDays ? n * 24 : n) };
}

/** Shared /where logic — geocodes the address, updates the subscriber's
 *  `location` (so the map pin moves) and `current_address`. Optional TTL
 *  ("/where ... for 24h") sets current_location_expires_at; a cron job sweeps
 *  expired rows back to home. Returns true on success so callers can clear
 *  conversational state. */
async function processWhereInput(
  supa: ReturnType<typeof serviceClient>,
  token: string,
  chatId: number,
  rawAddress: string,
): Promise<boolean> {
  const { address, ttlHours } = parseTtlHours(rawAddress.trim());
  if (!address) {
    await tgSendMessage(token, {
      chat_id: chatId,
      text: 'I didn\'t get an address. Tap 📍 Location again and try once more.',
    });
    return false;
  }
  const geo = await geocodeAddress(address);
  if (!geo) {
    await tgSendMessage(token, {
      chat_id: chatId,
      text:
        'Couldn\'t find that address. Try a more specific format — e.g. ' +
        '"123 Main St, Memphis TN 38103".',
    });
    return false;
  }
  const wkt = `SRID=4326;POINT(${geo.lng} ${geo.lat})`;
  const expiresAt = ttlHours != null
    ? new Date(Date.now() + ttlHours * 3600_000).toISOString()
    : null;
  const { error } = await supa
    .from('subscribers')
    .update({
      current_address: geo.matchedAddress ?? address,
      current_address_updated_at: new Date().toISOString(),
      current_location_expires_at: expiresAt,
      location: wkt,
      ...(geo.countyFips ? { county_fips: geo.countyFips } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('telegram_chat_id', chatId);
  if (error) {
    await tgSendMessage(token, {
      chat_id: chatId,
      text: 'Could not update your location. Are you signed up? Try /start.',
    });
    return false;
  }
  const ttlBlurb = ttlHours != null
    ? `\n\nAuto-reverts to home in ${ttlHours}h (${new Date(Date.now() + ttlHours * 3600_000).toLocaleString()}).`
    : '\n\nTap 🏠 Back to home (Location menu) when you are home again.';
  await tgSendMessage(token, {
    chat_id: chatId,
    text: `Got it — pin moved to:\n${geo.matchedAddress ?? address}${ttlBlurb}`,
  });
  return true;
}

/** Shared /home logic — reverts the subscriber's location to home_location
 *  and clears current_address. */
async function processHomeInput(
  supa: ReturnType<typeof serviceClient>,
  token: string,
  chatId: number,
): Promise<void> {
  const { data: subRow } = await supa
    .from('subscribers')
    .select('home_location')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();
  const update: Record<string, unknown> = {
    current_address: null,
    current_address_updated_at: null,
    current_location_expires_at: null,
    updated_at: new Date().toISOString(),
  };
  if (subRow?.home_location) update.location = subRow.home_location;
  await supa
    .from('subscribers')
    .update(update)
    .eq('telegram_chat_id', chatId);
  await tgSendMessage(token, {
    chat_id: chatId,
    text: 'Pin moved back to your home address.',
  });
}

async function sendStatusForChat(
  supa: ReturnType<typeof serviceClient>,
  token: string,
  chatId: number,
) {
  const { data: sub } = await supa
    .from('subscribers')
    .select('display_name, status, zip, county_fips, home_address, current_address, current_address_updated_at, alert_preferences, quiet_hours')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();
  if (!sub) {
    await tgSendMessage(token, {
      chat_id: chatId,
      text: 'I do not have you on file. Please sign up on the website first.',
    });
    return;
  }
  const prefs = parseAlertPreferences(sub.alert_preferences ?? DEFAULT_ALERT_PREFERENCES);
  const qh = parseQuietHours(sub.quiet_hours);
  const onOff = (b: boolean) => (b ? 'on' : 'off');
  const enabledTypes = [
    prefs.warnings && 'warnings',
    prefs.watches && 'watches',
    prefs.advisories && 'advisories',
    prefs.statements && 'statements',
  ].filter(Boolean).join(', ') || 'none';
  const lines = [
    `Status — ${sub.display_name ?? 'subscriber'}`,
    `• Account: ${sub.status ?? '—'}`,
    sub.current_address
      ? `• Now at (temporary): ${sub.current_address}`
      : sub.home_address
        ? `• Home: ${sub.home_address}`
        : `• Location: ZIP ${sub.zip ?? '—'}`,
    `• Alert types: ${enabledTypes}`,
    `• Quiet hours: ${qh.enabled ? `${onOff(qh.enabled)} (${qh.start}–${qh.end} ${qh.timezone})` : 'off'}`,
  ];
  if (prefs.skip_hazards.length > 0) {
    lines.push(`• Muted hazards: ${prefs.skip_hazards.join(', ')}`);
  }
  lines.push('', 'Tap ⚙️ Alerts to change anything, or 📍 Location to update where you are.');
  await tgSendMessage(token, { chat_id: chatId, text: lines.join('\n') });
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

const VALID_REPORT_HAZARDS = new Set(['tornado', 'funnel', 'wind', 'hail', 'flood', 'other']);
const REPORT_RATE_LIMIT_SEC = 60;

type ReportMeta = {
  hazard?: string;
  lat?: number;
  lon?: number;
};

/** Pick the largest entry from Telegram's photo size array. */
function largestPhoto(photo: unknown): { file_id: string } | null {
  if (!Array.isArray(photo) || photo.length === 0) return null;
  const last = photo[photo.length - 1];
  if (typeof last?.file_id !== 'string') return null;
  return { file_id: last.file_id };
}

/** Finalize an in-progress report — uploads any attached photo, inserts the
 *  row, notifies the operator, clears subscriber state. */
async function submitStormReport(
  supa: ReturnType<typeof serviceClient>,
  token: string,
  chatId: number,
  subscriberId: string,
  meta: ReportMeta,
  opts: {
    fileId?: string | null;
    description?: string | null;
    reporterLabel: string;
  },
): Promise<void> {
  const hazard = meta.hazard;
  const lat = meta.lat;
  const lon = meta.lon;
  if (!hazard || lat == null || lon == null) {
    await tgSendMessage(token, {
      chat_id: chatId,
      text: 'Sorry — I lost track of your report. Send /report to start over.',
    });
    await clearAwaiting(supa, subscriberId);
    return;
  }

  // Per-subscriber rate limit. Cheap row read — `subscriber_idx` covers it.
  const since = new Date(Date.now() - REPORT_RATE_LIMIT_SEC * 1000).toISOString();
  const { data: recent } = await supa
    .from('telegram_storm_reports')
    .select('id')
    .eq('subscriber_id', subscriberId)
    .gte('reported_at', since)
    .limit(1)
    .maybeSingle();
  if (recent) {
    await tgSendMessage(token, {
      chat_id: chatId,
      text: 'You just submitted a report — please wait a minute before sending another.',
    });
    await clearAwaiting(supa, subscriberId);
    return;
  }

  let photoUrl: string | null = null;
  if (opts.fileId) {
    try {
      const file = await tgFetchFile(token, opts.fileId);
      const ext = file.mime === 'image/png' ? 'png' : file.mime === 'image/webp' ? 'webp' : 'jpg';
      const path = `${subscriberId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supa.storage
        .from('storm-report-photos')
        .upload(path, file.bytes, { contentType: file.mime, upsert: false, cacheControl: '86400' });
      if (upErr) {
        console.error('storm-report photo upload failed', upErr);
      } else {
        const { data: pub } = supa.storage.from('storm-report-photos').getPublicUrl(path);
        photoUrl = pub?.publicUrl ?? null;
      }
    } catch (e) {
      console.error('tgFetchFile failed', e);
    }
  }

  const { data: inserted, error: insErr } = await supa
    .from('telegram_storm_reports')
    .insert({
      subscriber_id: subscriberId,
      hazard,
      description: opts.description ?? null,
      photo_url: photoUrl,
      photo_file_id: opts.fileId ?? null,
      lat,
      lon,
      point: `SRID=4326;POINT(${lon} ${lat})`,
    })
    .select('id')
    .single();

  if (insErr) {
    console.error('storm-report insert failed', insErr);
    await tgSendMessage(token, {
      chat_id: chatId,
      text: 'Could not save your report — please try again in a moment.',
    });
    await clearAwaiting(supa, subscriberId);
    return;
  }

  await clearAwaiting(supa, subscriberId);

  await tgSendMessage(token, {
    chat_id: chatId,
    text:
      `✅ Storm report submitted (${hazardLabel(hazard)}).\n` +
      `Plotted at ${lat.toFixed(3)}, ${lon.toFixed(3)}.\n\n` +
      'Stay safe — if you are in danger, call 911.',
  });

  // Self-Telegram the operator with the report summary + photo if available.
  const opChatId = await operatorChatId(supa);
  if (opChatId) {
    const summary =
      `📣 Storm report from ${opts.reporterLabel}\n` +
      `Hazard: ${hazardLabel(hazard)}\n` +
      `Location: ${lat.toFixed(4)}, ${lon.toFixed(4)}` +
      (opts.description ? `\nNote: ${opts.description.slice(0, 400)}` : '') +
      `\nReport id: ${inserted.id}`;
    if (photoUrl) {
      // sendPhoto with caption — Telegram fetches the public URL itself.
      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: opChatId, photo: photoUrl, caption: summary }),
      }).catch((e) => console.error('operator sendPhoto failed', e));
    } else {
      await tgSendMessage(token, { chat_id: opChatId, text: summary });
    }
  }
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

  // One-time setup query: POST .../telegram-webhook?setup_commands=1
  const setupUrl = new URL(req.url);
  if (setupUrl.searchParams.get('setup_commands') === '1') {
    try {
      await tgSetMyCommands(token, [...SUBSCRIBER_BOT_COMMANDS]);
      await tgSetChatMenuButtonCommands(token);
      return json({ ok: true, setup: 'commands_registered' });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }

  const supa = serviceClient();

  try {
    // ── edited_message: live-location refresh ────────────────────────────
    // Telegram emits an edited_message every ~30 s while a subscriber is
    // sharing live location. We treat these as silent position refreshes —
    // no reply (would be ~960 messages per 8 h share). Only refresh rows
    // already marked as an active telegram_live share so an unrelated
    // edit (e.g. corrected text message that happens to carry a stale
    // location preview) can't clobber a static pin.
    const edited = update.edited_message ?? update.edited_channel_post;
    if (edited?.location && edited?.chat?.id) {
      const { latitude, longitude } = edited.location as {
        latitude: number; longitude: number;
      };
      const chatId: number = edited.chat.id;
      const { data: sub } = await supa
        .from('subscribers')
        .select('id, current_location_source, current_location_expires_at')
        .eq('telegram_chat_id', chatId)
        .maybeSingle();
      if (
        sub &&
        sub.current_location_source === 'telegram_live' &&
        sub.current_location_expires_at &&
        new Date(sub.current_location_expires_at as string).getTime() > Date.now()
      ) {
        await supa
          .from('subscribers')
          .update({
            location: `SRID=4326;POINT(${longitude} ${latitude})`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', sub.id);
      }
      return json({ ok: true });
    }

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

      const cmd = parseCmdCallback(data);
      if (cmd && (await handleSubscriberCmdCallback(supa, token, chatId, cqId, cmd))) {
        return json({ ok: true });
      }

      // ── wx:safe / wx:sos — active-weather safety check-in (Phase #35) ──
      // Auto-attached to tornado/severe/flood warnings by telegram-send-worker.
      // Records the response on check_in_responses + replies for the operator,
      // and for SOS additionally pages the operator via self-Telegram with
      // the subscriber's current location.
      if (data === 'wx:safe' || data === 'wx:sos') {
        const { data: sub } = await supa
          .from('subscribers')
          .select('id, display_name, telegram_username, current_address, home_address')
          .eq('telegram_chat_id', chatId)
          .maybeSingle();
        if (!sub) {
          await tgAnswerCallbackQuery(token, cqId);
          return json({ ok: true });
        }
        // Resolve which outbound this was a tap on (cq.message.message_id).
        const tgMsgId = cq.message?.message_id ?? null;
        let messageId: string | null = null;
        if (tgMsgId) {
          const { data: outRow } = await supa
            .from('outbound_queue')
            .select('message_id')
            .eq('subscriber_id', sub.id)
            .eq('telegram_message_id', tgMsgId)
            .maybeSingle();
          messageId = outRow?.message_id ?? null;
        }
        if (messageId) {
          await supa.from('check_in_responses').upsert(
            {
              message_id: messageId,
              subscriber_id: sub.id,
              response_code: data === 'wx:safe' ? 'safe' : 'sos',
              responded_at: new Date().toISOString(),
            },
            { onConflict: 'message_id,subscriber_id' },
          );
        }
        // Mirror to inbox so the operator's thread shows the response.
        const { data: conv } = await supa
          .from('conversations')
          .upsert(
            { subscriber_id: sub.id, last_message_at: new Date().toISOString() },
            { onConflict: 'subscriber_id' },
          )
          .select('id')
          .single();
        if (conv) {
          await supa.from('replies').insert({
            conversation_id: conv.id,
            subscriber_id: sub.id,
            parent_message_id: messageId,
            callback_data: data,
            body: data === 'wx:safe' ? '[check-in] safe' : '[check-in] SOS',
            telegram_message_id: tgMsgId,
            is_distress: data === 'wx:sos',
          });
        }
        // Reply to the subscriber + acknowledge the button press.
        if (data === 'wx:safe') {
          await tgAnswerCallbackQuery(token, cqId, 'Got it — stay safe.');
          await tgSendMessage(token, {
            chat_id: chatId,
            text:
              '✅ Marked safe. Operator has been notified you are OK.\n\n' +
              'If conditions change, tap 🆘 Need help on the warning message.',
          });
        } else {
          await tgAnswerCallbackQuery(token, cqId, 'CALL 911. Operator alerted.', {
            show_alert: true,
          });
          await tgSendMessage(token, {
            chat_id: chatId,
            text:
              '🆘 *Call 911 immediately.* The bot has alerted the operator, ' +
              'but 911 is the fastest way to get rescue services to you.\n\n' +
              'Stay sheltered if it is safe to do so. Tap 📡 Share live ' +
              'location below so help can find you.',
            parse_mode: 'MarkdownV2',
          });
          // Self-Telegram the operator.
          const opChatId = Number(Deno.env.get('OPERATOR_TELEGRAM_CHAT_ID') ?? 0);
          if (opChatId) {
            const where = sub.current_address ?? sub.home_address ?? '(no address on file)';
            const handle = sub.telegram_username ? `@${sub.telegram_username}` : sub.display_name ?? 'subscriber';
            await tgSendMessage(token, {
              chat_id: opChatId,
              text:
                `🆘 SOS from ${handle}\n` +
                `Location: ${where}\n` +
                `Sent in response to a warning.`,
            });
          }
        }
        return json({ ok: true });
      }

      // ── fb:* — post-alert feedback (👍 👎 💬) ─────────────────────────
      // Auto-attached to NWS-sourced messages by telegram-send-worker. Writes
      // public.alert_feedback so the operator can tune which categories /
      // hazards subscribers find useful vs. noise. Tapping again overwrites
      // (unique on message_id, subscriber_id). The 💬 Reply variant primes a
      // force_reply prompt — actual reply goes through the normal reply path
      // and lands in conversations/replies the way any text reply would.
      if (data === 'fb:up' || data === 'fb:down' || data === 'fb:reply') {
        const { data: sub } = await supa
          .from('subscribers')
          .select('id')
          .eq('telegram_chat_id', chatId)
          .maybeSingle();
        if (!sub) {
          await tgAnswerCallbackQuery(token, cqId);
          return json({ ok: true });
        }
        const tgMsgId = cq.message?.message_id ?? null;
        let messageId: string | null = null;
        if (tgMsgId) {
          const { data: outRow } = await supa
            .from('outbound_queue')
            .select('message_id')
            .eq('subscriber_id', sub.id)
            .eq('telegram_message_id', tgMsgId)
            .maybeSingle();
          messageId = outRow?.message_id ?? null;
        }
        if (messageId) {
          const sentiment =
            data === 'fb:up' ? 'up' : data === 'fb:down' ? 'down' : 'reply';
          await supa.from('alert_feedback').upsert(
            { message_id: messageId, subscriber_id: sub.id, sentiment },
            { onConflict: 'message_id,subscriber_id' },
          );
        }
        if (data === 'fb:reply') {
          await tgAnswerCallbackQuery(token, cqId);
          await tgSendMessage(token, {
            chat_id: chatId,
            text:
              '💬 Send your reply as a normal message — it goes straight to the operator.',
            reply_markup: { force_reply: true, selective: true },
          });
        } else {
          const ack =
            data === 'fb:up' ? 'Thanks — noted as useful.' : 'Thanks — noted.';
          await tgAnswerCallbackQuery(token, cqId, ack);
        }
        return json({ ok: true });
      }

      // ── onb:* — onboarding follow-up actions (Phase #37) ───────────────
      if (data === 'onb:add_watches' || data === 'onb:location_help' || data === 'onb:done') {
        const { data: sub } = await supa
          .from('subscribers')
          .select('id, alert_preferences')
          .eq('telegram_chat_id', chatId)
          .maybeSingle();
        if (!sub) {
          await tgAnswerCallbackQuery(token, cqId);
          return json({ ok: true });
        }
        if (data === 'onb:add_watches') {
          const prefs = (sub.alert_preferences ?? {}) as Record<string, unknown>;
          await supa
            .from('subscribers')
            .update({
              alert_preferences: { ...prefs, watches: true },
              updated_at: new Date().toISOString(),
            })
            .eq('id', sub.id);
          await tgAnswerCallbackQuery(token, cqId, 'Watches enabled.');
          await tgSendMessage(token, {
            chat_id: chatId,
            text:
              '✅ Watches enabled. You will now get heads-up notifications ' +
              "(severe thunderstorm, tornado, etc.) before any warning is " +
              'issued for your area. Tap ⚙️ Alerts to fine-tune anytime.',
          });
        } else if (data === 'onb:location_help') {
          await tgAnswerCallbackQuery(token, cqId);
          await tgSendMessage(token, {
            chat_id: chatId,
            text:
              "📍 Two ways to tell me where you are:\n\n" +
              '• Tap 📡 Share live location below — Telegram drops your real pin.\n' +
              '• Tap 📍 Location → ✏️ Update temporary address — for when you\'re traveling.\n\n' +
              'You can also use /where 123 Main St, Memphis TN — and add ' +
              '"for 24h" or "for 3 days" to auto-revert to your home address.',
          });
        } else {
          await tgAnswerCallbackQuery(token, cqId, "You're all set.");
          await tgSendMessage(token, {
            chat_id: chatId,
            text: "👍 You're set. I'll only message you when something actually matters.",
          });
        }
        return json({ ok: true });
      }

      // ── loc:* — Location submenu (Phase #34) ───────────────────────────
      if (data === 'loc:set' || data === 'loc:home') {
        const { data: sub } = await supa
          .from('subscribers')
          .select('id')
          .eq('telegram_chat_id', chatId)
          .maybeSingle();
        if (!sub) {
          await tgAnswerCallbackQuery(token, cqId, 'Not signed up yet.');
          return json({ ok: true });
        }
        if (data === 'loc:set') {
          await setAwaiting(supa, sub.id, 'address');
          await tgAnswerCallbackQuery(token, cqId);
          await tgSendMessage(token, {
            chat_id: chatId,
            text:
              '✏️ Reply with your current address, e.g.\n' +
              '"123 Main St, Memphis TN 38103"\n\n' +
              "I'll move your map pin there until you tap 🏠 Back to home.",
            reply_markup: { force_reply: true, selective: true },
          });
        } else {
          await processHomeInput(supa, token, chatId);
          await tgAnswerCallbackQuery(token, cqId);
        }
        return json({ ok: true });
      }

      // ── report:* — storm-report flow (subscriber-side) ─────────────────
      if (data.startsWith('report:')) {
        const action = data.slice('report:'.length);
        const { data: sub } = await supa
          .from('subscribers')
          .select('id')
          .eq('telegram_chat_id', chatId)
          .eq('status', 'active')
          .maybeSingle();
        if (!sub) {
          await tgAnswerCallbackQuery(token, cqId, 'Sign up first.');
          return json({ ok: true });
        }
        if (action === 'cancel') {
          await clearAwaiting(supa, sub.id);
          await tgAnswerCallbackQuery(token, cqId, 'Cancelled.');
          await tgSendMessage(token, {
            chat_id: chatId,
            text: 'Report cancelled. Send /report again whenever you need to.',
          });
          return json({ ok: true });
        }
        if (action === 'skip_media') {
          // Submit a description-only report (or hazard-only).
          const state = await getAwaiting(supa, sub.id);
          const meta = (state?.meta ?? {}) as ReportMeta;
          await tgAnswerCallbackQuery(token, cqId);
          // Resolve a friendly reporter label for the operator notification.
          const { data: subRow } = await supa
            .from('subscribers')
            .select('display_name, telegram_username')
            .eq('id', sub.id)
            .maybeSingle();
          const reporterLabel =
            (subRow?.telegram_username ? `@${subRow.telegram_username}` : null) ??
            subRow?.display_name ?? 'subscriber';
          await submitStormReport(supa, token, chatId, sub.id, meta, {
            fileId: null,
            description: (meta as Record<string, unknown>).description as string ?? null,
            reporterLabel,
          });
          return json({ ok: true });
        }
        if (!VALID_REPORT_HAZARDS.has(action)) {
          await tgAnswerCallbackQuery(token, cqId);
          return json({ ok: true });
        }
        // Hazard selected — stash it and ask for a fresh location share.
        await setAwaiting(
          supa,
          sub.id,
          'report_location',
          { hazard: action },
        );
        await tgAnswerCallbackQuery(token, cqId, `${hazardLabel(action)} selected.`);
        await tgSendMessage(token, {
          chat_id: chatId,
          text:
            '📍 Now share your current location so the report plots accurately.\n\n' +
            'Tap the button below — Telegram will attach your GPS pin. ' +
            'This location is only used for this report; your home pin is not changed.',
          reply_markup: {
            keyboard: [
              [{ text: '📍 Share location for this report', request_location: true }],
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        });
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
          'You are signed up for Mid-South WX alerts. 🌩\n\n' +
          'The buttons under the message box are your menu:\n' +
          '🌩 Status · 📍 Location · ⚙️ Alerts · 💬 Help · 📡 Share live location',
        reply_markup: subscriberReplyKeyboard(),
      });
      // Onboarding follow-up — gives the operator a guided opt-in to watches
      // and a nudge to share their live location. Each button maps to a
      // `onb:*` callback handled below.
      await tgSendMessage(token, {
        chat_id: chatId,
        text:
          '⚡ Quick setup — pick the ones that fit you:\n\n' +
          'By default you only get the most urgent alerts (warnings). If you ' +
          'also want a heads-up (watches), tap below. You can change this ' +
          'anytime under ⚙️ Alerts.',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚙️ Also send me watches', callback_data: 'onb:add_watches' }],
            [{ text: '📍 How do I update my location?', callback_data: 'onb:location_help' }],
            [{ text: '✅ I am all set', callback_data: 'onb:done' }],
          ],
        },
      });
      return json({ ok: true });
    }

    if (isCommandsMenuText(text) || isHelpMenuText(text)) {
      await sendCommandsHelp(token, chatId);
      return json({ ok: true });
    }

    if (isPrefsMenuText(text)) {
      await showPrefsForChat(supa, token, chatId);
      return json({ ok: true });
    }

    if (isStatusMenuText(text)) {
      await sendStatusForChat(supa, token, chatId);
      return json({ ok: true });
    }

    if (isLocationMenuText(text)) {
      await tgSendMessage(token, {
        chat_id: chatId,
        text:
          'Location options — tap one:\n\n' +
          '✏️ Update temporary address — for when you are traveling.\n' +
          '🏠 Back to home address — restores your map pin to home.\n' +
          'Or tap "📡 Share live location" on the keyboard to attach a Telegram pin.',
        reply_markup: locationInlineKeyboard(),
      });
      return json({ ok: true });
    }

    // /where <address> — geocode + move the map pin. Same helper that the
    // guided "📍 Location → ✏️ Update temporary address" flow calls.
    if (text?.startsWith('/where') || text?.startsWith('/here')) {
      const address = text.replace(/^\/(where|here)\s*/, '').trim();
      if (!address) {
        await tgSendMessage(token, {
          chat_id: chatId,
          text:
            'Send `/where` followed by an address, e.g. `/where 123 Main St, Memphis TN`. ' +
            'Or tap 📍 Location for a guided flow.',
        });
        return json({ ok: true });
      }
      await processWhereInput(supa, token, chatId, address);
      return json({ ok: true });
    }

    // /report — kick off the storm-report flow.
    if (text === '/report' || text?.startsWith('/report ') || text?.startsWith('/report@')) {
      const { data: sub } = await supa
        .from('subscribers')
        .select('id')
        .eq('telegram_chat_id', chatId)
        .eq('status', 'active')
        .maybeSingle();
      if (!sub) {
        await tgSendMessage(token, {
          chat_id: chatId,
          text: 'You need to finish sign-up first. Use the link from the website.',
        });
        return json({ ok: true });
      }
      await clearAwaiting(supa, sub.id);
      await tgSendMessage(token, {
        chat_id: chatId,
        text:
          '📣 What are you reporting?\n\n' +
          'Tap a hazard below. After that I will ask you to share your location ' +
          'and (optionally) attach a photo. Reports plot on the operator map ' +
          'with your name and a thumbnail.',
        reply_markup: reportHazardKeyboard(),
      });
      return json({ ok: true });
    }

    // /home — clear current-address override (back at home)
    if (text === '/prefs' || text?.startsWith('/prefs ')) {
      await showPrefsForChat(supa, token, chatId);
      return json({ ok: true });
    }

    if (text === '/home') {
      await processHomeInput(supa, token, chatId);
      return json({ ok: true });
    }

    if (text === '/unsubscribe' || /^stop$/i.test(text || '')) {
      await supa
        .from('subscribers')
        .update({ status: 'unsubscribed', updated_at: new Date().toISOString() })
        .eq('telegram_chat_id', chatId);
      await tgSendMessage(token, {
        chat_id: chatId,
        text: 'You are unsubscribed from Mid-South WX. Send /resume to turn alerts back on.',
      });
      return json({ ok: true });
    }

    // /resume — re-activate a previously-unsubscribed subscriber. No new
    // sign-up link required. Only flips status if the row already exists in
    // 'unsubscribed' or 'paused'; pending subscribers still need /start.
    if (text === '/resume' || /^resume$/i.test(text ?? '') || /^start$/i.test(text ?? '')) {
      const { data: existing } = await supa
        .from('subscribers')
        .select('id, status')
        .eq('telegram_chat_id', chatId)
        .maybeSingle();
      if (!existing) {
        await tgSendMessage(token, {
          chat_id: chatId,
          text: 'I do not have you on file. Sign up via the website link first.',
        });
        return json({ ok: true });
      }
      if (existing.status === 'active') {
        await tgSendMessage(token, {
          chat_id: chatId,
          text: 'You are already active — alerts are flowing.',
        });
        return json({ ok: true });
      }
      if (existing.status !== 'unsubscribed' && existing.status !== 'paused') {
        await tgSendMessage(token, {
          chat_id: chatId,
          text: 'Use the website sign-up link to finish setup.',
        });
        return json({ ok: true });
      }
      await supa
        .from('subscribers')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      await tgSendMessage(token, {
        chat_id: chatId,
        text: '✅ Alerts re-enabled. Tap ⚙️ Alerts to review what types you receive.',
        reply_markup: subscriberReplyKeyboard(),
      });
      return json({ ok: true });
    }

    // Location share — update the subscriber's geometry. Two flavors:
    //   - Static: a one-shot pin (no `live_period`). Just save the point.
    //   - Live: `live_period` set → save the point AND set an expiry so the
    //     existing /where TTL cron sweeps the subscriber back to home when
    //     Telegram stops emitting edits. Subsequent edited_message updates
    //     (handled at the top of this serve()) refresh the same row in place.
    // If the subscriber is mid-/report flow, capture the point onto the
    // report meta instead of moving their home pin.
    if (msg.location) {
      const { latitude, longitude, live_period } = msg.location as {
        latitude: number; longitude: number; live_period?: number;
      };

      const { data: subForReport } = await supa
        .from('subscribers')
        .select('id')
        .eq('telegram_chat_id', chatId)
        .maybeSingle();
      if (subForReport) {
        const reportState = await getAwaiting(supa, subForReport.id);
        if (reportState?.awaiting === 'report_location') {
          const meta = (reportState.meta ?? {}) as ReportMeta;
          await setAwaiting(supa, subForReport.id, 'report_media', {
            ...meta,
            lat: latitude,
            lon: longitude,
          });
          await tgSendMessage(token, {
            chat_id: chatId,
            text:
              `Location captured (${latitude.toFixed(3)}, ${longitude.toFixed(3)}).\n\n` +
              '📷 Now send a photo of what you are reporting (you can add a ' +
              'caption with details), or just send a text description.\n\n' +
              'Tap below if you want to submit without a photo.',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⏭ Submit without photo', callback_data: 'report:skip_media' }],
                [{ text: '✖️ Cancel', callback_data: 'report:cancel' }],
              ],
            },
          });
          return json({ ok: true });
        }
      }

      const isLive = typeof live_period === 'number' && live_period > 0;
      const update: Record<string, unknown> = {
        location: `SRID=4326;POINT(${longitude} ${latitude})`,
        updated_at: new Date().toISOString(),
      };
      if (isLive) {
        // msg.date is unix seconds (Telegram's standard). Add live_period
        // and convert to ISO timestamp for the TTL column.
        const expiresMs = ((msg.date as number) + live_period!) * 1000;
        update.current_location_expires_at = new Date(expiresMs).toISOString();
        update.current_location_source = 'telegram_live';
      } else {
        // A static pin replaces any prior source tag so a later live share
        // doesn't see this row as already-tracked.
        update.current_location_source = null;
      }
      await supa
        .from('subscribers')
        .update(update)
        .eq('telegram_chat_id', chatId);
      await tgSendMessage(token, {
        chat_id: chatId,
        text: isLive
          ? `📡 Live location active for ${Math.round(live_period! / 60)} min. ` +
            'Alerts will follow you while Telegram is sharing; we auto-revert to home when the share ends.'
          : 'Location updated. You will now receive alerts based on your precise position.',
      });
      return json({ ok: true });
    }

    // Free-text inbound → reply in inbox
    const { data: sub } = await supa
      .from('subscribers')
      .select('id, display_name, telegram_username')
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

    // Storm-report flow: when we're awaiting media, a photo (or a plain text
    // description) finalizes the report. Photos win — Telegram delivers the
    // caption as `msg.caption`.
    const photo = largestPhoto(msg.photo);
    const reportState = await getAwaiting(supa, sub.id);
    if (reportState?.awaiting === 'report_media' && (photo || text)) {
      const meta = (reportState.meta ?? {}) as ReportMeta;
      const reporterLabel = sub.telegram_username
        ? `@${sub.telegram_username}`
        : sub.display_name ?? 'subscriber';
      await submitStormReport(supa, token, chatId, sub.id, meta, {
        fileId: photo?.file_id ?? null,
        description: (msg.caption as string | undefined) ?? text ?? null,
        reporterLabel,
      });
      return json({ ok: true });
    }

    // State-aware: if the bot was awaiting a specific kind of input from
    // this subscriber (e.g. "reply with your current address" after they
    // tapped the Location → Update temporary address button), consume the
    // text as that input instead of treating it as a chat reply.
    if (text) {
      if (reportState?.awaiting === 'address') {
        const ok = await processWhereInput(supa, token, chatId, text);
        if (ok) await clearAwaiting(supa, sub.id);
        return json({ ok: true });
      }
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

    // Threading: if the user long-pressed → Reply on a specific outbound
    // message, Telegram passes its telegram_message_id back to us. The send
    // worker stamps every outbound_queue row with its telegram_message_id so
    // we can resolve back to messages.id here. Scope the lookup to THIS
    // subscriber's deliveries so we never thread across users.
    let parent_message_id: string | null = null;
    const rtmId = msg.reply_to_message?.message_id;
    if (rtmId) {
      const { data: outRow } = await supa
        .from('outbound_queue')
        .select('message_id')
        .eq('subscriber_id', sub.id)
        .eq('telegram_message_id', rtmId)
        .maybeSingle();
      parent_message_id = outRow?.message_id ?? null;
    }

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
