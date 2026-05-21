// Claims nws_alerts (status=new), applies auto_alert_rules, inserts messages, enqueues when mode=auto.

import { serviceClient, json } from './supabase.ts';
import { notifyExternalEndpointsForMessage } from './external-notify.ts';
import { notifyOperatorNwsPending } from './operator-notify.ts';

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

function fillTemplate(
  body: string,
  ctx: { headline: string; event: string; expiresAt: string; areaDesc: string },
): string {
  return body
    .replace(/\{\{headline\}\}/g, ctx.headline)
    .replace(/\{\{event\}\}/g, ctx.event)
    .replace(/\{\{expires_at\}\}/g, ctx.expiresAt)
    .replace(/\{\{area_desc\}\}/g, ctx.areaDesc);
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
};

type RuleRow = {
  id: string;
  event_pattern: string;
  min_severity: string | null;
  mode: 'auto' | 'review' | 'ignore';
  region_filter: Record<string, unknown> | null;
  template_id: string | null;
  enabled: boolean;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const supa = serviceClient();

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
  let processed = 0;

  for (const alert of rows) {
    try {
      let matchedRule: RuleRow | null = null;
      for (const rule of rules) {
        if (!eventMatches(rule.event_pattern, alert.event)) continue;
        if (!severityOk(rule.min_severity, alert.severity)) continue;
        matchedRule = rule;
        break;
      }

      const finish = async (status: 'dispatched' | 'skipped') => {
        const { error } = await supa.rpc('nws_finish_dispatch', {
          p_alert_id: alert.id,
          p_status: status,
        });
        if (error) throw new Error(error.message);
      };

      if (!matchedRule) {
        await finish('skipped');
        processed++;
        continue;
      }

      if (matchedRule.mode === 'ignore') {
        await finish('skipped');
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
        await finish('skipped');
        processed++;
        continue;
      }

      const tpl = matchedRule.template_id ? tplMap.get(matchedRule.template_id) : null;
      if (!tpl) {
        await finish('skipped');
        processed++;
        continue;
      }

      const ctx = {
        headline: alert.headline ?? alert.event,
        event: alert.event,
        expiresAt: alert.expires_at ? new Date(alert.expires_at).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : 'unknown',
        areaDesc: alert.area_desc ?? '',
      };

      const bodyMd = fillTemplate(tpl.body_md, ctx);

      const audience_spec = { subscribers: ids };

      if (matchedRule.mode === 'review') {
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
          })
          .select('id')
          .single();
        if (insErr || !reviewMsg) throw new Error(insErr?.message ?? 'insert failed');

        const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgToken) {
          notifyOperatorNwsPending(supa, tgToken, {
            messageId: reviewMsg.id,
            event: alert.event,
            headline: alert.headline,
            recipientCount: ids.length,
            bodyPreview: bodyMd,
          }).catch((e) => console.error('nws operator notify', e));
        }

        await finish('dispatched');
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

      await finish('dispatched');
      processed++;
    } catch (e) {
      console.error('nws-dispatcher row', alert.id, e);
      await supa.rpc('nws_finish_dispatch', { p_alert_id: alert.id, p_status: 'skipped' });
    }
  }

  return json({ ok: true, claimed: rows.length, processed });
});
