// Outbound send worker. Called by pg_cron every minute (and may be invoked
// ad-hoc by a server action immediately after queueing a message).
//
// Behavior:
//   1. Claim up to BATCH pending rows with FOR UPDATE SKIP LOCKED.
//   2. Send to Telegram, respecting ~25 msg/s across distinct chats.
//   3. On 429, sleep retry_after, requeue remainder.
//   4. On 5xx / network error, increment attempts; mark 'failed' after 5.
//   5. Update outbound_queue + delivery_logs + messages.status.
//
// Idempotency: BATCH is bounded, locks expire if function dies, attempts
// counter prevents infinite retry.

import { serviceClient, json, withHealthLog } from './_shared/supabase.ts';
import {
  buildInlineKeyboard,
  mdToTelegramHtml,
  TelegramRateLimit,
  tgSendMessage,
  tgSendMedia,
  type QuickReply,
} from './_shared/telegram.ts';
import { deferThirtyMinutes, deliveryDecision } from './subscriber-prefs.ts';
import {
  formatImpactPrefix,
  isConvectiveWarning,
  parseEventMotion,
  timeToImpact,
  type StormMotion,
} from './impact.ts';
import {
  formatAggregatedBody,
  hazardKindOf,
  planAggregation,
  type AggregationGroup,
} from './aggregation.ts';

const BATCH = 200;          // rows per cron tick
const RATE_PER_SEC = 25;    // safely under Telegram's 30/s
const MAX_ATTEMPTS = 5;
const LOCK_TTL_SEC = 60;

type ClaimedRow = {
  id: number;
  message_id: string;
  subscriber_id: string;
  attempts: number;
  body_rendered: string;
  quick_replies: QuickReply[] | null;
  telegram_chat_id: number;
  message_source: string;
  nws_event: string | null;
  alert_preferences: unknown;
  quiet_hours: unknown;
  media_url: string | null;
  media_type: string | null;
  subscriber_lon: number | null;
  subscriber_lat: number | null;
  home_stale: boolean | null;
  live_sharing: boolean | null;
};

async function claimBatch(supa: ReturnType<typeof serviceClient>) {
  // Use a CTE update to atomically claim a batch.
  const lockedBy = `worker-${crypto.randomUUID()}`;
  const { data, error } = await supa.rpc('claim_outbound_batch', {
    p_limit: BATCH,
    p_locked_by: lockedBy,
    p_lock_ttl_sec: LOCK_TTL_SEC,
  });
  if (error) {
    console.error('claim_outbound_batch failed', error);
    return [] as ClaimedRow[];
  }
  return (data ?? []) as ClaimedRow[];
}

// Fetch context for every NWS-sourced message in this batch: storm motion
// (for the time-to-impact prefix), area_desc + severity + raw event string
// (for the aggregation summary). Map key is message_id so the send loop's
// per-row lookup is a single hop. Null entries mean "no NWS context" — the
// prefix and aggregation are skipped for those.
export type AlertContext = {
  motion: StormMotion | null;
  areaDesc: string | null;
  severity: string | null;
};

async function loadAlertContexts(
  supa: ReturnType<typeof serviceClient>,
  rows: ClaimedRow[],
): Promise<Map<string, AlertContext>> {
  // We need context for any NWS row, not just convective ones — aggregation
  // also runs on watches/advisories. The motion path narrows to convective
  // warnings naturally because parseEventMotion returns null for the rest.
  const nwsMessageIds = [
    ...new Set(rows.filter((r) => r.message_source === 'nws').map((r) => r.message_id)),
  ];
  const out = new Map<string, AlertContext>();
  if (nwsMessageIds.length === 0) return out;

  // Two-step join: avoid PostgREST embed quirks by resolving alert IDs first,
  // then loading their `raw` payloads. Same number of round trips overall.
  const { data: msgs, error: msgsErr } = await supa
    .from('messages')
    .select('id, nws_alert_id')
    .in('id', nwsMessageIds);
  if (msgsErr) {
    console.error('loadAlertContexts messages lookup failed', msgsErr);
    return out;
  }

  const alertIdByMessage = new Map<string, string>();
  for (const m of msgs ?? []) {
    if (m.nws_alert_id) alertIdByMessage.set(m.id, m.nws_alert_id);
  }
  const alertIds = [...new Set(alertIdByMessage.values())];
  if (alertIds.length === 0) return out;

  const { data: alerts, error: alertsErr } = await supa
    .from('nws_alerts')
    .select('id, raw, area_desc, severity')
    .in('id', alertIds);
  if (alertsErr) {
    console.error('loadAlertContexts alerts lookup failed', alertsErr);
    return out;
  }

  const ctxByAlert = new Map<string, AlertContext>();
  for (const a of alerts ?? []) {
    const raw = a.raw as
      | { properties?: { parameters?: Record<string, unknown> } }
      | null
      | undefined;
    ctxByAlert.set(a.id, {
      motion: parseEventMotion(raw?.properties?.parameters?.eventMotionDescription),
      areaDesc: a.area_desc ?? null,
      severity: a.severity ?? null,
    });
  }

  for (const [msgId, alertId] of alertIdByMessage) {
    out.set(msgId, ctxByAlert.get(alertId) ?? { motion: null, areaDesc: null, severity: null });
  }
  return out;
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// Two-tap safety check-in for high-risk warnings. Synthesized at send time
// (NOT stored on the message) so the operator can override with their own
// quick_replies when they want a different prompt.
const ACTIVE_WX_BUTTONS: QuickReply[] = [
  { label: '✅ I am safe', data: 'wx:safe' },
  { label: '🆘 Need help', data: 'wx:sos' },
];

// Post-event feedback row appended below the safety check-in (or stood alone
// for non-warning NWS messages: watches, advisories, MDs, statements). Gives
// the operator a tuning signal per (subscriber × event category) without
// adding a separate follow-up message. Persisted to public.alert_feedback.
const FEEDBACK_BUTTONS: QuickReply[] = [
  { label: '👍 Useful', data: 'fb:up' },
  { label: '👎 Not useful', data: 'fb:down' },
  { label: '💬 Reply', data: 'fb:reply' },
];

// Nudge button appended when a convective warning lands for a subscriber
// whose home pin hasn't been refreshed in 48+ hours. Tapping it routes to
// the existing onb:location_help handler in telegram-webhook, which DMs the
// /where instructions. Suppressed during an active Telegram live-share since
// the pin is already moving in real time.
const LOCATION_REFRESH_BUTTON: QuickReply = {
  label: '📍 Update location',
  data: 'onb:location_help',
};

function classifyHazardEvent(event: string | null | undefined): {
  category: 'warning' | 'watch' | 'advisory' | 'discussion' | 'statement' | 'other';
  hazard: 'tornado' | 'severe' | 'flood' | 'winter' | 'heat' | 'wind' | 'other';
} {
  const e = (event ?? '').toLowerCase();
  let category: ReturnType<typeof classifyHazardEvent>['category'] = 'other';
  if (e.includes('mesoscale discussion')) category = 'discussion';
  else if (e.includes('warning') || e.includes('emergency')) category = 'warning';
  else if (e.includes('watch')) category = 'watch';
  else if (e.includes('advisory')) category = 'advisory';
  else if (e.includes('statement') || e.includes('outlook')) category = 'statement';

  let hazard: ReturnType<typeof classifyHazardEvent>['hazard'] = 'other';
  if (e.includes('tornado')) hazard = 'tornado';
  else if (e.includes('severe thunderstorm') || e.includes('hail')) hazard = 'severe';
  else if (e.includes('flash flood') || e.includes('flood')) hazard = 'flood';
  else if (e.includes('winter') || e.includes('ice') || e.includes('blizzard')) hazard = 'winter';
  else if (e.includes('heat')) hazard = 'heat';
  else if (e.includes('wind') || e.includes('gale')) hazard = 'wind';
  return { category, hazard };
}

/** Decide which inline keyboard to attach. Operator-set quick_replies always
 *  win; otherwise NWS-sourced messages get an auto-keyboard:
 *    - high-risk warnings (tornado/severe/flood): safety check-in + feedback
 *    - other NWS categories (watch/advisory/MD/statement):       feedback only
 *    - non-NWS broadcasts: no auto-keyboard
 *  When `stalePinNudge` is true, the location-refresh button is appended at
 *  the end so a stale-home subscriber can tap to re-confirm their pin. */
function pickQuickReplies(
  quickReplies: QuickReply[] | null,
  nwsEvent: string | null,
  messageSource: string | null,
  stalePinNudge: boolean,
): QuickReply[] | undefined {
  // Operator-set keyboard always wins — don't second-guess explicit overrides.
  if (quickReplies && quickReplies.length > 0) return quickReplies;

  let base: QuickReply[] | undefined;
  if (messageSource === 'nws') {
    const { category, hazard } = classifyHazardEvent(nwsEvent);
    const safetyApplies =
      category === 'warning' && (hazard === 'tornado' || hazard === 'severe' || hazard === 'flood');
    base = safetyApplies
      ? [...ACTIVE_WX_BUTTONS, ...FEEDBACK_BUTTONS]
      : [...FEEDBACK_BUTTONS];
  }

  if (!stalePinNudge) return base;
  // Stale-pin nudge piggybacks onto the auto-keyboard. For non-NWS messages
  // with no other buttons, we still attach the nudge on its own.
  return base ? [...base, LOCATION_REFRESH_BUTTON] : [LOCATION_REFRESH_BUTTON];
}

/** Stale-pin nudge fires only when:
 *   - the message is a convective NWS warning (where impact direction matters)
 *   - home_stale was true at claim time (>48 h since home_location refresh)
 *   - subscriber isn't actively live-sharing (live pin is already current) */
function shouldNudgeStalePin(row: ClaimedRow): boolean {
  if (!row.home_stale || row.live_sharing) return false;
  if (row.message_source !== 'nws') return false;
  return isConvectiveWarning(row.nws_event);
}

Deno.serve(withHealthLog('telegram-send-worker', async (req) => {
  // Both pg_cron (auth header) and manual triggers from the dashboard reach here.
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ ok: false }, 405);
  }

  const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!tgToken) return json({ ok: false, error: 'bot token missing' }, 500);

  const supa = serviceClient();
  const rows = await claimBatch(supa);
  if (!rows.length) return json({ ok: true, sent: 0, claimed: 0 });

  // One DB hit per batch to load NWS context (storm motion, area_desc,
  // severity). Used for the time-to-impact prefix AND outbreak aggregation.
  const alertContexts = await loadAlertContexts(supa, rows);

  const intervalMs = Math.floor(1000 / RATE_PER_SEC);
  let sent = 0;
  let failed = 0;
  const touchedMessages = new Set<string>();

  // Outbreak aggregation: subscribers with ≥2 eligible NWS rows in this batch
  // get one summary message instead of N pings. Runs BEFORE the per-row loop
  // so aggregated row IDs can be filtered out of the loop's working set.
  const { groups, aggregatedRowIds } = planAggregation(
    rows,
    alertContexts,
    (r) => r.message_id,
  );

  for (const group of groups) {
    for (const m of group.members) touchedMessages.add(m.row.message_id);

    // Quiet-hours decision driven by the lead (highest-hazard) member. If the
    // lead would defer, the whole group defers — keeps quiet-hours semantics
    // consistent ("does this hazard override quiet?") instead of leaking the
    // aggregated send around the constraint via lower-hazard members.
    const leadRow = group.lead.row;
    const decision = deliveryDecision({
      messageSource: leadRow.message_source,
      nwsEvent: leadRow.nws_event,
      quietHours: leadRow.quiet_hours,
    });
    if (decision === 'defer') {
      const memberIds = group.members.map((m) => m.row.id);
      await supa
        .from('outbound_queue')
        .update({
          status: 'pending',
          locked_at: null,
          locked_by: null,
          send_after: deferThirtyMinutes(),
        })
        .in('id', memberIds);
      continue;
    }

    try {
      const replyMarkup = buildInlineKeyboard(
        pickQuickReplies(
          leadRow.quick_replies,
          leadRow.nws_event,
          leadRow.message_source,
          shouldNudgeStalePin(leadRow),
        ),
      );
      const html = mdToTelegramHtml(formatAggregatedBody(group.members));

      // Aggregated messages never carry media — multiple polygons can't be
      // represented in a single sendPhoto, and falling back to text is
      // safer than picking one polygon to mislead the rest.
      const result = await tgSendMessage(tgToken, {
        chat_id: leadRow.telegram_chat_id,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });

      const memberIds = group.members.map((m) => m.row.id);
      await supa
        .from('outbound_queue')
        .update({
          status: 'sent',
          telegram_message_id: result.message_id,
          sent_at: new Date().toISOString(),
          last_error: null,
          locked_at: null,
          locked_by: null,
        })
        .in('id', memberIds);

      // One delivery_logs row per member so per-message check-in tallies
      // still show the recipient was reached; meta flags the aggregation
      // so the operator can correlate when reviewing.
      const logs = group.members.map((m) => ({
        outbound_id: m.row.id,
        message_id: m.row.message_id,
        subscriber_id: m.row.subscriber_id,
        event: 'sent' as const,
        meta: {
          telegram_message_id: result.message_id,
          aggregated_with: group.members
            .map((x) => x.row.message_id)
            .filter((id) => id !== m.row.message_id),
          lead_message_id: group.lead.row.message_id,
          hazard: hazardKindOf(leadRow.nws_event),
        },
      }));
      await supa.from('delivery_logs').insert(logs);

      sent += group.members.length;
    } catch (e) {
      if (e instanceof TelegramRateLimit) {
        const memberIds = group.members.map((m) => m.row.id);
        await supa
          .from('outbound_queue')
          .update({
            status: 'pending',
            locked_at: null,
            locked_by: null,
            send_after: new Date(Date.now() + e.retryAfterSec * 1000).toISOString(),
          })
          .in('id', memberIds);
        await sleep(e.retryAfterSec * 1000);
        // Drop out of aggregation entirely on rate-limit — the surviving
        // per-row loop below will re-handle non-aggregated work next tick.
        break;
      }

      // Non-rate-limit failure: increment attempts on all members; mark
      // failed once the lead hits the max. Treating the group as a unit
      // keeps the queue state consistent.
      const attempts = group.members.reduce(
        (max, m) => Math.max(max, m.row.attempts + 1),
        0,
      );
      const isFinal = attempts >= MAX_ATTEMPTS;
      const memberIds = group.members.map((m) => m.row.id);
      await supa
        .from('outbound_queue')
        .update({
          status: isFinal ? 'failed' : 'pending',
          attempts,
          last_error: String(e).slice(0, 500),
          locked_at: null,
          locked_by: null,
          send_after: new Date(Date.now() + attempts * 30_000).toISOString(),
        })
        .in('id', memberIds);

      const logs = group.members.map((m) => ({
        outbound_id: m.row.id,
        message_id: m.row.message_id,
        subscriber_id: m.row.subscriber_id,
        event: 'failed' as const,
        meta: { error: String(e), attempts, aggregated: true },
      }));
      await supa.from('delivery_logs').insert(logs);
      failed += group.members.length;
    }

    await sleep(intervalMs);
  }

  for (const row of rows) {
    if (aggregatedRowIds.has(row.id)) continue;
    touchedMessages.add(row.message_id);

    const decision = deliveryDecision({
      messageSource: row.message_source,
      nwsEvent: row.nws_event,
      quietHours: row.quiet_hours,
    });

    if (decision === 'defer') {
      await supa
        .from('outbound_queue')
        .update({
          status: 'pending',
          locked_at: null,
          locked_by: null,
          send_after: deferThirtyMinutes(),
        })
        .eq('id', row.id);
      continue;
    }

    try {
      const replyMarkup = buildInlineKeyboard(
        pickQuickReplies(
          row.quick_replies,
          row.nws_event,
          row.message_source,
          shouldNudgeStalePin(row),
        ),
      );

      // Per-subscriber time-to-impact prefix for convective warnings. The
      // prefix is plain text, prepended before markdown→HTML conversion so
      // any future Telegram-HTML escaping applies to it too.
      let bodyText = row.body_rendered;
      const motion = alertContexts.get(row.message_id)?.motion ?? null;
      if (
        motion &&
        row.subscriber_lon != null &&
        row.subscriber_lat != null
      ) {
        const impact = timeToImpact(motion, {
          lon: row.subscriber_lon,
          lat: row.subscriber_lat,
        });
        if (impact) {
          const prefix = formatImpactPrefix(impact);
          if (prefix) bodyText = prefix + bodyText;
        }
      }

      const html = mdToTelegramHtml(bodyText);
      let result: { message_id: number; chat: { id: number } };

      if (row.media_url && row.media_type) {
        // Telegram caption limit is 1024 chars; trim body if longer.
        const caption = html.length > 1024 ? html.slice(0, 1021) + '…' : html;
        const kind = (
          ['animation', 'photo', 'video', 'document'].includes(row.media_type)
            ? row.media_type
            : 'document'
        ) as 'animation' | 'photo' | 'video' | 'document';
        result = await tgSendMedia(tgToken, {
          chat_id: row.telegram_chat_id,
          url: row.media_url,
          kind,
          caption,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
      } else {
        result = await tgSendMessage(tgToken, {
          chat_id: row.telegram_chat_id,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: replyMarkup,
        });
      }

      await supa
        .from('outbound_queue')
        .update({
          status: 'sent',
          telegram_message_id: result.message_id,
          sent_at: new Date().toISOString(),
          last_error: null,
          locked_at: null,
          locked_by: null,
        })
        .eq('id', row.id);

      await supa.from('delivery_logs').insert({
        outbound_id: row.id,
        message_id: row.message_id,
        subscriber_id: row.subscriber_id,
        event: 'sent',
        meta: { telegram_message_id: result.message_id },
      });

      sent++;
    } catch (e) {
      if (e instanceof TelegramRateLimit) {
        // Release this row + remaining rows so the next tick picks them up.
        const remainingIds = rows
          .slice(rows.indexOf(row))
          .map((r) => r.id);
        await supa
          .from('outbound_queue')
          .update({
            status: 'pending',
            locked_at: null,
            locked_by: null,
            send_after: new Date(Date.now() + e.retryAfterSec * 1000).toISOString(),
          })
          .in('id', remainingIds);
        await sleep(e.retryAfterSec * 1000);
        break;
      }

      const attempts = row.attempts + 1;
      const isFinal = attempts >= MAX_ATTEMPTS;
      await supa
        .from('outbound_queue')
        .update({
          status: isFinal ? 'failed' : 'pending',
          attempts,
          last_error: String(e).slice(0, 500),
          locked_at: null,
          locked_by: null,
          send_after: new Date(Date.now() + attempts * 30_000).toISOString(),
        })
        .eq('id', row.id);

      await supa.from('delivery_logs').insert({
        outbound_id: row.id,
        message_id: row.message_id,
        subscriber_id: row.subscriber_id,
        event: 'failed',
        meta: { error: String(e), attempts },
      });
      failed++;
    }

    await sleep(intervalMs);
  }

  // Roll up message status: if no remaining pending/sending rows for a message, mark sent.
  for (const mid of touchedMessages) {
    const { count } = await supa
      .from('outbound_queue')
      .select('*', { count: 'exact', head: true })
      .eq('message_id', mid)
      .in('status', ['pending', 'sending']);
    if ((count ?? 0) === 0) {
      await supa
        .from('messages')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', mid)
        .neq('status', 'sent');
    } else {
      await supa
        .from('messages')
        .update({ status: 'sending' })
        .eq('id', mid)
        .eq('status', 'queued');
    }
  }

  return json({ ok: true, claimed: rows.length, sent, failed });
}));
