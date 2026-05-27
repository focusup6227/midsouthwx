// event-recap — post-event summary DM.
//
// Cron every 5 min. For each NWS alert that has:
//   - status in ('expired', 'cancelled')
//   - recap_sent_at IS NULL
//   - expires_at within the last 6 hours
// we look up:
//   - the original message that was sent for the alert
//   - subscribers who actually received it (outbound_queue.status='sent')
//   - their check-in responses (safe / sos / other / silent)
//   - LSRs that landed inside the polygon during the active window
// and queue a single recap message back to those subscribers. If neither the
// LSR list nor the check-in tally has anything interesting to share, we
// mark recap_sent_at anyway so we don't re-evaluate forever.

import { serviceClient, json, withHealthLog } from './supabase.ts';

const BATCH = 10;        // alerts per tick
const LOOKBACK_HOURS = 6;
const QUIET_BUFFER_MIN = 2; // wait this long after expires_at to give late LSRs a chance

type ExpiredAlert = {
  id: string;
  nws_id: string;
  event: string;
  area_desc: string | null;
  effective: string | null;
  expires_at: string | null;
  status: string;
};

type LsrRow = {
  id: string;
  event: string;
  hazard: string | null;
  magnitude: string | null;
  location: string | null;
  occurred_at: string;
};

type CheckInRow = { response_code: string | null };

type SentRow = { subscriber_id: string };

function hazardEmoji(event: string, hazard: string | null): string {
  const e = event.toLowerCase();
  const h = (hazard ?? '').toLowerCase();
  if (e.includes('tornado') || h === 'tornado') return '🌪️';
  if (e.includes('hail')) return '🧊';
  if (e.includes('wnd') || e.includes('wind') || h === 'wind') return '💨';
  if (e.includes('flood') || h === 'flood') return '💧';
  if (e.includes('tstm') || e.includes('thunderstorm') || h === 'severe') return '⛈';
  if (e.includes('snow') || e.includes('ice') || h === 'winter') return '❄️';
  return '⚠️';
}

function shortenLocation(loc: string | null): string {
  if (!loc) return 'area';
  // LSRs use "2 NE BARTLETT" — title-case the trailing token block for readability.
  return loc
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function summarizeCheckins(rows: CheckInRow[], totalSent: number): {
  safe: number;
  distress: number;
  other: number;
  silent: number;
} {
  let safe = 0;
  let distress = 0;
  let other = 0;
  for (const r of rows) {
    const code = r.response_code;
    if (code === 'safe') safe++;
    else if (code === 'help' || code === 'sos') distress++;
    else if (code) other++;
  }
  const responded = safe + distress + other;
  const silent = Math.max(0, totalSent - responded);
  return { safe, distress, other, silent };
}

function buildRecapBody(
  alert: ExpiredAlert,
  lsrs: LsrRow[],
  tally: { safe: number; distress: number; other: number; silent: number },
  totalSent: number,
): string | null {
  const hasLsrs = lsrs.length > 0;
  const hasResponses = tally.safe + tally.distress + tally.other > 0;
  if (!hasLsrs && !hasResponses) return null; // nothing to say

  const verb = alert.status === 'cancelled' ? 'cancelled' : 'ended';
  const area = alert.area_desc ?? 'area';
  const header = `✓ ${alert.event} ${verb} — ${area}`;

  const lines: string[] = [header, ''];

  if (hasLsrs) {
    lines.push(`${lsrs.length} report${lsrs.length === 1 ? '' : 's'} in your area:`);
    for (const r of lsrs) {
      const mag = r.magnitude ? ` (${r.magnitude})` : '';
      lines.push(`${hazardEmoji(r.event, r.hazard)} ${r.event} · ${shortenLocation(r.location)}${mag}`);
    }
    lines.push('');
  } else {
    lines.push('No storm reports filed in your area.');
    lines.push('');
  }

  if (totalSent > 0) {
    const parts: string[] = [];
    if (tally.safe) parts.push(`${tally.safe} safe`);
    if (tally.distress) parts.push(`<b>${tally.distress} SOS</b>`);
    if (tally.other) parts.push(`${tally.other} other`);
    if (tally.silent) parts.push(`${tally.silent} silent`);
    if (parts.length > 0) {
      lines.push(`Check-ins: ${parts.join(' · ')}`);
    }
  }

  return lines.join('\n').trim();
}

Deno.serve(withHealthLog('event-recap', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const supa = serviceClient();
  const now = new Date();
  const oldestExpires = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000).toISOString();
  const newestExpires = new Date(now.getTime() - QUIET_BUFFER_MIN * 60_000).toISOString();

  const { data: alerts, error: alertsErr } = await supa
    .from('nws_alerts')
    .select('id, nws_id, event, area_desc, effective, expires_at, status')
    .in('status', ['expired', 'cancelled'])
    .is('recap_sent_at', null)
    .gte('expires_at', oldestExpires)
    .lte('expires_at', newestExpires)
    .order('expires_at', { ascending: true })
    .limit(BATCH);

  if (alertsErr) return json({ ok: false, error: alertsErr.message }, 500);

  const rows = (alerts ?? []) as ExpiredAlert[];
  let recapped = 0;
  let skipped_no_audience = 0;
  let skipped_no_content = 0;

  for (const alert of rows) {
    try {
      // Find the original message we sent for this alert. There can in
      // theory be more than one (review then re-sent) — most-recent wins.
      const { data: msgs } = await supa
        .from('messages')
        .select('id')
        .eq('nws_alert_id', alert.id)
        .eq('source', 'nws')
        .order('created_at', { ascending: false })
        .limit(1);
      const originalMessageId = msgs?.[0]?.id ?? null;

      if (!originalMessageId) {
        // Alert was skipped or had empty audience — nothing to recap.
        await supa.from('nws_alerts').update({ recap_sent_at: now.toISOString() }).eq('id', alert.id);
        skipped_no_audience++;
        continue;
      }

      const { data: sentRows } = await supa
        .from('outbound_queue')
        .select('subscriber_id')
        .eq('message_id', originalMessageId)
        .eq('status', 'sent');
      const subscriberIds = ((sentRows ?? []) as SentRow[]).map((r) => r.subscriber_id);

      if (subscriberIds.length === 0) {
        await supa.from('nws_alerts').update({ recap_sent_at: now.toISOString() }).eq('id', alert.id);
        skipped_no_audience++;
        continue;
      }

      const { data: checkRows } = await supa
        .from('check_in_responses')
        .select('response_code')
        .eq('message_id', originalMessageId);
      const tally = summarizeCheckins((checkRows ?? []) as CheckInRow[], subscriberIds.length);

      const { data: lsrRows } = await supa.rpc('event_recap_lsrs', { p_alert_id: alert.id });
      const lsrs = (lsrRows ?? []) as LsrRow[];

      const body = buildRecapBody(alert, lsrs, tally, subscriberIds.length);
      if (!body) {
        await supa.from('nws_alerts').update({ recap_sent_at: now.toISOString() }).eq('id', alert.id);
        skipped_no_content++;
        continue;
      }

      const { data: recapMsg, error: insErr } = await supa
        .from('messages')
        .insert({
          body_md: body,
          body_rendered: body,
          source: 'recap',
          status: 'draft',
          audience_spec: { subscribers: subscriberIds },
          quick_replies: null,
          nws_alert_id: alert.id,
          recipient_count: 0,
          created_by: null,
        })
        .select('id')
        .single();
      if (insErr || !recapMsg) {
        console.error('[event-recap] insert failed', alert.id, insErr);
        continue;
      }

      const { error: enqErr } = await supa.rpc('enqueue_message_system', {
        p_message_id: recapMsg.id,
      });
      if (enqErr) {
        await supa.from('messages').delete().eq('id', recapMsg.id);
        console.error('[event-recap] enqueue failed', alert.id, enqErr);
        continue;
      }

      await supa
        .from('nws_alerts')
        .update({ recap_sent_at: now.toISOString() })
        .eq('id', alert.id);

      recapped++;
    } catch (e) {
      console.error('[event-recap] row failed', alert.id, e);
      // Don't mark recap_sent_at on transient failures — let the next tick retry.
    }
  }

  return json({
    ok: true,
    scanned: rows.length,
    recapped,
    skipped_no_audience,
    skipped_no_content,
  });
}));
