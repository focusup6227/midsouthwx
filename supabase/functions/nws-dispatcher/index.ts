// Claims nws_alerts (status=new), applies auto_alert_rules, inserts messages, enqueues when mode=auto.

import { serviceClient, json, withHealthLog } from './supabase.ts';
import { notifyExternalEndpointsForMessage } from './external-notify.ts';
import { notifyOperatorNwsPending, notifyOperatorTornado } from './operator-notify.ts';
import { attachAlertSnapshot } from './snapshot.ts';

const BATCH = 15;
const LOCK_TTL_SEC = 120;

const SEVERITY_RANK: Record<string, number> = {
  unknown: 0,
  minor: 1,
  moderate: 2,
  severe: 3,
  extreme: 4,
};

function severityRank(s: string | null | undefined): number {
  if (!s) return 0;
  return SEVERITY_RANK[s.toLowerCase()] ?? 0;
}

function severityOk(minSeverity: string | null | undefined, alertSev: string | null | undefined): boolean {
  if (!minSeverity?.trim()) return true;
  return severityRank(alertSev) >= severityRank(minSeverity);
}

function eventMatches(pattern: string, event: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p.endsWith('*')) return event.startsWith(p.slice(0, -1));
  return p === event;
}

// Build the public-facing /alert/<nws_id> URL for {{url}} placeholders.
// Subscribers tap this from Telegram to see the polygon on a map plus the full
// CAP headline / instructions. Returns '' when PUBLIC_SITE_URL secret isn't
// set (dev / first deploy) so templates referencing {{url}} degrade to an
// empty string rather than breaking the message body.
function publicAlertUrl(nwsId: string): string {
  const base = Deno.env.get('PUBLIC_SITE_URL')?.replace(/\/$/, '');
  if (!base) return '';
  return `${base}/alert/${encodeURIComponent(nwsId)}`;
}

function fillTemplate(
  body: string,
  ctx: {
    headline: string;
    event: string;
    expiresAt: string;
    areaDesc: string;
    url: string;
    nwsId: string;
  },
): string {
  return body
    .replace(/\{\{headline\}\}/g, ctx.headline)
    .replace(/\{\{event\}\}/g, ctx.event)
    .replace(/\{\{expires_at\}\}/g, ctx.expiresAt)
    .replace(/\{\{area_desc\}\}/g, ctx.areaDesc)
    .replace(/\{\{url\}\}/g, ctx.url)
    .replace(/\{\{nws_id\}\}/g, ctx.nwsId);
}

type ClaimedAlert = {
  id: string;
  nws_id: string;
  event: string;
  severity: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  area_desc: string | null;
  expires_at: string | null;
  raw: Record<string, unknown> | null;
  message_type: string | null;
  vtec_event_key: string | null;
  vtec_action: string | null;
};

// VTEC P-VTEC action codes. NEW gets a full broadcast. CAN/EXP are
// cancellations/expirations — we skip outright (they arrive as fresh CAP
// messages and would otherwise re-trigger the auto-rule and re-broadcast).
// CON/EXT/EXA/EXB/COR are follow-ups for an event we may have already
// broadcast; if a prior CAP for the same VTEC event_key is already
// status='dispatched', skip the duplicate.
const VTEC_CANCEL_ACTIONS = new Set(['CAN', 'EXP']);
const VTEC_FOLLOWUP_ACTIONS = new Set(['CON', 'EXT', 'EXA', 'EXB', 'COR']);

// Window between queueing a PDS/TorE message as pending_approval and the
// dispatcher auto-promoting it to queued if the operator hasn't intervened.
// 30 s matches the client countdown rendered on /nws.
const AUTO_SEND_WINDOW_SEC = 30;

// Detect Particularly Dangerous Situation / Tornado Emergency from the
// alert's raw VTEC parameters + headline. Duplicated (in spirit) with the
// browser-side classifyAlertSeverity in lib/nws/display.ts; Edge runtime
// can't import app code so we re-state the rules here. Keep them in sync.
function isPdsOrTornadoEmergency(alert: ClaimedAlert): boolean {
  const evt = alert.event.toLowerCase();
  const headline = (alert.headline ?? '').toLowerCase();
  const description = (alert.description ?? '').toLowerCase();
  if (/\btornado emergency\b/.test(evt) || /\btornado emergency\b/.test(headline) || /\btornado emergency\b/.test(description)) {
    return true;
  }
  if (/particularly dangerous situation/.test(headline) || /particularly dangerous situation/.test(description)) {
    return true;
  }
  const props = (alert.raw as { properties?: { parameters?: Record<string, unknown> | null } } | null)?.properties ?? null;
  const params = props?.parameters ?? null;
  if (!params) return false;
  const readParam = (k: string): string | null => {
    const v = (params as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      const s = v.find((x) => typeof x === 'string') as string | undefined;
      return s ? s.toLowerCase() : null;
    }
    return typeof v === 'string' ? v.toLowerCase() : null;
  };
  const torDamage = readParam('tornadoDamageThreat');
  const damageThreat = readParam('damageThreat');
  if (torDamage === 'catastrophic' || torDamage === 'destructive' || torDamage === 'considerable') return true;
  if (damageThreat === 'catastrophic' || damageThreat === 'destructive' || damageThreat === 'considerable') return true;
  return false;
}

type RuleRow = {
  id: string;
  event_pattern: string;
  min_severity: string | null;
  mode: 'auto' | 'review' | 'ignore';
  region_filter: Record<string, unknown> | null;
  template_id: string | null;
  enabled: boolean;
};

Deno.serve(withHealthLog('nws-dispatcher', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  // Operator kill-switch for swapping to cap-dispatcher without touching cron.
  // Symmetric with CAP_DISPATCHER_ENABLED on the sibling function so the two
  // pipelines can be flipped via env vars alone.
  if (Deno.env.get('NWS_DISPATCHER_DISABLED') === '1') {
    return json({ ok: true, disabled: true });
  }

  const supa = serviceClient();

  // Server-side fallback for the PDS / Tornado Emergency 30-second auto-send
  // window. The client countdown promotes via approveNwsMessage when the
  // operator is watching; this catches the case where the dashboard tab is
  // closed or the operator's internet is down. Best-effort: failure here
  // shouldn't block the normal dispatch loop.
  try {
    const { data: promoted, error: promoteErr } = await supa.rpc(
      'promote_auto_send_messages',
    );
    if (promoteErr) {
      console.error('promote_auto_send_messages', promoteErr);
    } else if (Array.isArray(promoted) && promoted.length > 0) {
      console.log('promote_auto_send_messages', promoted.length);
    }
  } catch (e) {
    console.error('promote_auto_send_messages threw', e);
  }

  const { data: rulesRaw, error: rulesErr } = await supa
    .from('auto_alert_rules')
    .select('id, event_pattern, min_severity, mode, region_filter, template_id, enabled')
    .eq('enabled', true)
    .order('created_at', { ascending: true });

  if (rulesErr) return json({ ok: false, error: rulesErr.message }, 500);

  const rules = (rulesRaw ?? []) as RuleRow[];
  const templateIds = [...new Set(rules.map((r) => r.template_id).filter(Boolean))] as string[];

  const { data: templates } = templateIds.length
    ? await supa.from('templates').select('id, body_md, default_quick_replies').in('id', templateIds)
    : { data: [] as { id: string; body_md: string; default_quick_replies: unknown }[] };

  const tplMap = new Map((templates ?? []).map((t) => [t.id, t]));

  const lockedBy = `nws-${crypto.randomUUID()}`;
  const { data: claimed, error: claimErr } = await supa.rpc('claim_nws_alert_batch', {
    p_limit: BATCH,
    p_locked_by: lockedBy,
    p_lock_ttl_sec: LOCK_TTL_SEC,
  });

  if (claimErr) {
    console.error('claim_nws_alert_batch', claimErr);
    return json({ ok: false, error: claimErr.message }, 500);
  }

  const rows = (claimed ?? []) as ClaimedAlert[];
  // Hoisted once per dispatcher tick so the per-alert tornado push and the
  // existing pending-approval push share the same env read.
  const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  let processed = 0;

  for (const alert of rows) {
    try {
      const finishStatus = async (status: 'dispatched' | 'skipped') => {
        const { error } = await supa.rpc('nws_finish_dispatch', {
          p_alert_id: alert.id,
          p_status: status,
        });
        if (error) throw new Error(error.message);
      };

      // VTEC-aware dedup: short-circuit before tornado-notify so the operator
      // isn't re-buzzed for a Cancel or a Continuation of an event they've
      // already been alerted on. Non-VTEC alerts (e.g. SPC Mesoscale
      // Discussions) fall through with vtec_action=null.
      const action = (alert.vtec_action ?? '').toUpperCase();
      if (
        (action && VTEC_CANCEL_ACTIONS.has(action)) ||
        alert.message_type === 'Cancel'
      ) {
        await finishStatus('skipped');
        processed++;
        continue;
      }
      if (action && VTEC_FOLLOWUP_ACTIONS.has(action) && alert.vtec_event_key) {
        const { data: alreadyDispatched, error: dedupErr } = await supa.rpc(
          'nws_vtec_event_already_dispatched',
          { p_vtec_event_key: alert.vtec_event_key, p_exclude_id: alert.id },
        );
        if (dedupErr) {
          console.error('nws_vtec_event_already_dispatched', dedupErr);
        } else if (alreadyDispatched === true) {
          await finishStatus('skipped');
          processed++;
          continue;
        }
      }

      // Operator urgent push for Tornado Warning / Emergency. Decoupled from
      // the dispatch decision (rules, audience, etc.) so the operator always
      // hears about it. Atomic claim on operator_alerted_at prevents
      // double-sends if another dispatcher tick races.
      const isTornado =
        /tornado/i.test(alert.event) &&
        /(warning|emergency)/i.test(alert.event);
      if (isTornado && tgToken) {
        const { data: claimedNotify } = await supa
          .from('nws_alerts')
          .update({ operator_alerted_at: new Date().toISOString() })
          .eq('id', alert.id)
          .is('operator_alerted_at', null)
          .select('id');
        if (claimedNotify && claimedNotify.length > 0) {
          try {
            await notifyOperatorTornado(supa, tgToken, alert);
          } catch (e) {
            // Roll back so a later tick can retry. Logged for visibility.
            await supa
              .from('nws_alerts')
              .update({ operator_alerted_at: null })
              .eq('id', alert.id);
            console.error('notifyOperatorTornado failed', e);
          }
        }
      }

      let matchedRule: RuleRow | null = null;
      for (const rule of rules) {
        if (!eventMatches(rule.event_pattern, alert.event)) continue;
        if (!severityOk(rule.min_severity, alert.severity)) continue;
        matchedRule = rule;
        break;
      }

      if (!matchedRule) {
        await finishStatus('skipped');
        processed++;
        continue;
      }

      if (matchedRule.mode === 'ignore') {
        await finishStatus('skipped');
        processed++;
        continue;
      }

      const { data: audienceRows, error: audErr } = await supa.rpc('nws_alert_audience', {
        p_alert_id: alert.id,
        p_region_filter: matchedRule.region_filter ?? null,
      });

      if (audErr) throw new Error(audErr.message);

      const subscriberIds = (audienceRows ?? []) as { subscriber_id: string }[];
      const ids = subscriberIds.map((r) => r.subscriber_id).filter(Boolean);

      if (ids.length === 0) {
        await finishStatus('skipped');
        processed++;
        continue;
      }

      const tpl = matchedRule.template_id ? tplMap.get(matchedRule.template_id) : null;
      if (!tpl) {
        await finishStatus('skipped');
        processed++;
        continue;
      }

      const ctx = {
        headline: alert.headline ?? alert.event,
        event: alert.event,
        expiresAt: alert.expires_at ? new Date(alert.expires_at).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : 'unknown',
        areaDesc: alert.area_desc ?? '',
        url: publicAlertUrl(alert.nws_id),
        nwsId: alert.nws_id,
      };

      const bodyMd = fillTemplate(tpl.body_md, ctx);

      const audience_spec = { subscribers: ids };

      if (matchedRule.mode === 'review') {
        // PDS / Tornado Emergency get an auto-send countdown. The message
        // still lands as pending_approval so the operator can cancel during
        // the 30-second window, but if they don't intervene, either the
        // client UI or the server promote scan flushes it.
        const isHighSeverity = isPdsOrTornadoEmergency(alert);
        const autoSendAt = isHighSeverity
          ? new Date(Date.now() + AUTO_SEND_WINDOW_SEC * 1000).toISOString()
          : null;

        const { data: reviewMsg, error: insErr } = await supa
          .from('messages')
          .insert({
            body_md: bodyMd,
            body_rendered: bodyMd,
            source: 'nws',
            status: 'pending_approval',
            audience_spec,
            quick_replies: tpl.default_quick_replies,
            template_id: matchedRule.template_id,
            nws_alert_id: alert.id,
            recipient_count: ids.length,
            created_by: null,
            auto_send_at: autoSendAt,
          })
          .select('id')
          .single();
        if (insErr || !reviewMsg) throw new Error(insErr?.message ?? 'insert failed');

        // Render snapshot before the operator push so the approval prompt
        // and the eventually-sent message both reference the same media URL.
        // Synchronous: dispatcher already has 120 s on a single alert and the
        // operator notification's value drops fast if the snapshot lags.
        await attachAlertSnapshot(supa, {
          messageId: reviewMsg.id,
          alertId: alert.id,
          event: alert.event,
          raw: alert.raw,
        });

        if (tgToken) {
          notifyOperatorNwsPending(supa, tgToken, {
            messageId: reviewMsg.id,
            event: alert.event,
            headline: alert.headline,
            recipientCount: ids.length,
            bodyPreview: bodyMd,
          }).catch((e) => console.error('nws operator notify', e));
        }

        await finishStatus('dispatched');
        processed++;
        continue;
      }

      // auto
      const { data: msg, error: insErr } = await supa
        .from('messages')
        .insert({
          body_md: bodyMd,
          body_rendered: bodyMd,
          source: 'nws',
          status: 'draft',
          audience_spec,
          quick_replies: tpl.default_quick_replies,
          template_id: matchedRule.template_id,
          nws_alert_id: alert.id,
          recipient_count: 0,
          created_by: null,
        })
        .select('id')
        .single();

      if (insErr || !msg) throw new Error(insErr?.message ?? 'insert failed');

      // Stamp media_url BEFORE enqueue — the worker reads it via
      // claim_outbound_batch at send time, so it must be set on the message
      // row before queue rows exist.
      await attachAlertSnapshot(supa, {
        messageId: msg.id,
        alertId: alert.id,
        event: alert.event,
        raw: alert.raw,
      });

      const { error: enqErr } = await supa.rpc('enqueue_message_system', {
        p_message_id: msg.id,
      });

      if (enqErr) {
        await supa.from('messages').delete().eq('id', msg.id);
        throw new Error(enqErr.message);
      }

      notifyExternalEndpointsForMessage(supa, msg.id, {
        nws_id: alert.nws_id,
        event: alert.event,
        headline: alert.headline,
        area_desc: alert.area_desc,
        expires_at: alert.expires_at,
        severity: alert.severity,
      }).catch((e) => console.error('nws external notify', e));

      await finishStatus('dispatched');
      processed++;
    } catch (e) {
      console.error('nws-dispatcher row', alert.id, e);
      await supa.rpc('nws_finish_dispatch', { p_alert_id: alert.id, p_status: 'skipped' });
    }
  }

  return json({ ok: true, claimed: rows.length, processed });
}));
