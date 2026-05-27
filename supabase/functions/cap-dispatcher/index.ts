// Claims cap_alerts (status=new), applies auto_alert_rules, inserts messages,
// enqueues when mode=auto. Parallel to nws-dispatcher — see Stage 2 design note
// in supabase/migrations/20260607000003_cap_dispatcher_schema.sql.
//
// Stays inert until CAP_DISPATCHER_ENABLED=1 is set in Edge Function secrets.
// That guarantees deploying this function never changes dispatch behavior on
// its own — the operator has to opt in.
//
// Differences vs nws-dispatcher:
//   - Reads cap_alerts; uses parsed_event for rule.event_pattern matching.
//   - Audience is polygon-only (LibreWxR doesn't ship UGC/SAME). Alerts
//     without a polygon get 'skipped' status.
//   - Messages get source='cap' and cap_alert_id (not nws_alert_id) so the
//     two pipelines stay distinguishable in the messages table.
//   - No tornado-operator-push or NWS-pending-approval push in v1 — those
//     UIs are NWS-specific. Operator can still check /alerts to see CAP
//     pending_approval rows manually.

import { serviceClient, json, withHealthLog } from './supabase.ts';

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
  uri: string;
  parsed_event: string | null;
  title: string | null;
  severity: string | null;
  description: string | null;
  regions: string | null;
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

Deno.serve(withHealthLog('cap-dispatcher', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  // Safety gate: dispatcher does nothing unless explicitly enabled. Deploys
  // and cron schedule become inert behavior changes by themselves.
  if (Deno.env.get('CAP_DISPATCHER_ENABLED') !== '1') {
    return json({ ok: true, disabled: true });
  }

  const supa = serviceClient();

  // Shared auto_alert_rules table — both dispatchers consult the same rules.
  // Rule.event_pattern is matched against the alert's event string; for CAP
  // we use parsed_event (regex-extracted from LibreWxR's title).
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

  const lockedBy = `cap-${crypto.randomUUID()}`;
  const { data: claimed, error: claimErr } = await supa.rpc('claim_cap_alert_batch', {
    p_limit: BATCH,
    p_locked_by: lockedBy,
    p_lock_ttl_sec: LOCK_TTL_SEC,
  });

  if (claimErr) {
    console.error('claim_cap_alert_batch', claimErr);
    return json({ ok: false, error: claimErr.message }, 500);
  }

  const rows = (claimed ?? []) as ClaimedAlert[];
  let processed = 0;

  for (const alert of rows) {
    try {
      const event = alert.parsed_event ?? '';

      let matchedRule: RuleRow | null = null;
      for (const rule of rules) {
        if (!eventMatches(rule.event_pattern, event)) continue;
        if (!severityOk(rule.min_severity, alert.severity)) continue;
        matchedRule = rule;
        break;
      }

      const finish = async (status: 'dispatched' | 'skipped') => {
        const { error } = await supa.rpc('cap_finish_dispatch', {
          p_alert_id: alert.id,
          p_status: status,
        });
        if (error) throw new Error(error.message);
      };

      if (!matchedRule || matchedRule.mode === 'ignore') {
        await finish('skipped');
        processed++;
        continue;
      }

      const { data: audienceRows, error: audErr } = await supa.rpc('cap_alert_audience', {
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
        headline: alert.title ?? event,
        event,
        expiresAt: alert.expires_at
          ? new Date(alert.expires_at).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC'
          : 'unknown',
        // CAP regions string is "Clark, IN; Floyd, IN; ..." — works as a
        // human-readable area_desc substitute.
        areaDesc: alert.regions ?? '',
      };

      const bodyMd = fillTemplate(tpl.body_md, ctx);
      const audience_spec = { subscribers: ids };

      if (matchedRule.mode === 'review') {
        const { error: insErr } = await supa
          .from('messages')
          .insert({
            body_md: bodyMd,
            body_rendered: bodyMd,
            source: 'cap',
            status: 'pending_approval',
            audience_spec,
            quick_replies: tpl.default_quick_replies,
            template_id: matchedRule.template_id,
            cap_alert_id: alert.id,
            recipient_count: ids.length,
            created_by: null,
          });
        if (insErr) throw new Error(insErr.message);

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
          source: 'cap',
          status: 'draft',
          audience_spec,
          quick_replies: tpl.default_quick_replies,
          template_id: matchedRule.template_id,
          cap_alert_id: alert.id,
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

      await finish('dispatched');
      processed++;
    } catch (e) {
      console.error('cap-dispatcher row', alert.id, e);
      await supa.rpc('cap_finish_dispatch', { p_alert_id: alert.id, p_status: 'skipped' });
    }
  }

  return json({ ok: true, claimed: rows.length, processed });
}));
