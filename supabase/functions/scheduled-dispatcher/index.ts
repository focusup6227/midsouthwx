// Drains due scheduled_messages: materializes a messages row, enqueues outbound rows,
// advances recurrence or marks complete. Invoked by pg_cron every minute.
//
// When send_window_minutes > 0, creates a pending_approval message and DMs the operator
// with approve/skip buttons instead of enqueueing immediately.

import { rrulestr } from 'https://esm.sh/rrule@2.8.1';
import { serviceClient, json, withHealthLog } from './supabase.ts';
import { notifyExternalEndpointsForMessage } from './external-notify.ts';
import { notifyOperatorScheduledPending } from './operator-notify.ts';

const BATCH = 10;
const LOCK_TTL_SEC = 90;
const MAX_DISPATCH_ATTEMPTS = 5;

type ClaimedRow = {
  id: string;
  body_md: string;
  audience_spec: Record<string, unknown>;
  scheduled_for: string;
  rrule: string | null;
  template_id: string | null;
  created_by: string | null;
  send_window_minutes: number;
  dispatch_attempts: number;
  next_run_at: string;
};

type ScheduleMeta = {
  scheduled_message_id: string;
  approval_deadline: string;
  rrule: string | null;
  fired_at: string;
};

function computeNextIso(rruleIcs: string, currentRunIso: string): string | null {
  try {
    const rule = rrulestr(rruleIcs.trim(), { tzid: 'UTC' });
    const cur = new Date(currentRunIso);
    const after = new Date(cur.getTime() + 1000);
    const next = rule.after(after, false);
    return next ? next.toISOString() : null;
  } catch (e) {
    console.error('rrule parse failed', e);
    return null;
  }
}

async function advanceSchedule(
  supa: ReturnType<typeof serviceClient>,
  row: { id: string; rrule: string | null; next_run_at: string },
) {
  if (row.rrule?.trim()) {
    const nextIso = computeNextIso(row.rrule, row.next_run_at);
    if (!nextIso) {
      await supa
        .from('scheduled_messages')
        .update({
          status: 'sent',
          locked_at: null,
          locked_by: null,
          last_error: null,
          dispatch_attempts: 0,
        })
        .eq('id', row.id);
    } else {
      await supa
        .from('scheduled_messages')
        .update({
          next_run_at: nextIso,
          locked_at: null,
          locked_by: null,
          last_error: null,
          dispatch_attempts: 0,
        })
        .eq('id', row.id);
    }
  } else {
    await supa
      .from('scheduled_messages')
      .update({
        status: 'sent',
        locked_at: null,
        locked_by: null,
        last_error: null,
        dispatch_attempts: 0,
      })
      .eq('id', row.id);
  }
}

async function audienceCount(
  supa: ReturnType<typeof serviceClient>,
  spec: Record<string, unknown>,
): Promise<number> {
  const { data, error } = await supa.rpc('resolve_audience', { spec });
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

async function expireOverdueApprovals(supa: ReturnType<typeof serviceClient>) {
  const { data: pending } = await supa
    .from('messages')
    .select('id, audience_spec')
    .eq('source', 'scheduled')
    .eq('status', 'pending_approval');

  const now = Date.now();
  for (const msg of pending ?? []) {
    const meta = (msg.audience_spec as { _schedule?: ScheduleMeta })?._schedule;
    if (!meta?.approval_deadline || !meta.scheduled_message_id) continue;
    if (new Date(meta.approval_deadline).getTime() > now) continue;

    await supa.from('messages').update({ status: 'cancelled' }).eq('id', msg.id);
    await advanceSchedule(supa, {
      id: meta.scheduled_message_id,
      rrule: meta.rrule,
      next_run_at: meta.fired_at,
    });
  }
}

async function claimBatch(supa: ReturnType<typeof serviceClient>): Promise<ClaimedRow[]> {
  const lockedBy = `sched-${crypto.randomUUID()}`;
  const { data, error } = await supa.rpc('claim_scheduled_batch', {
    p_limit: BATCH,
    p_locked_by: lockedBy,
    p_lock_ttl_sec: LOCK_TTL_SEC,
  });
  if (error) {
    console.error('claim_scheduled_batch', error);
    return [];
  }
  return (data ?? []) as ClaimedRow[];
}

Deno.serve(withHealthLog('scheduled-dispatcher', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ ok: false }, 405);
  }

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const supa = serviceClient();
  await expireOverdueApprovals(supa);

  const rows = await claimBatch(supa);
  if (!rows.length) return json({ ok: true, processed: 0 });

  let processed = 0;
  const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');

  for (const row of rows) {
    try {
      // Skip if this schedule already has a pending approval in flight.
      const { data: pendingScheduled } = await supa
        .from('messages')
        .select('id, audience_spec')
        .eq('source', 'scheduled')
        .eq('status', 'pending_approval');

      const hasPending = (pendingScheduled ?? []).some(
        (m) =>
          (m.audience_spec as { _schedule?: { scheduled_message_id?: string } })?._schedule
            ?.scheduled_message_id === row.id,
      );

      if (hasPending) {
        await supa
          .from('scheduled_messages')
          .update({ locked_at: null, locked_by: null })
          .eq('id', row.id);
        continue;
      }

      let quickReplies: unknown = null;
      if (row.template_id) {
        const { data: tpl, error: tplErr } = await supa
          .from('templates')
          .select('default_quick_replies')
          .eq('id', row.template_id)
          .maybeSingle();
        if (tplErr) throw new Error(tplErr.message);
        quickReplies = tpl?.default_quick_replies ?? null;
      }

      const recipientCount = await audienceCount(supa, row.audience_spec);
      const needsApproval = row.send_window_minutes > 0;

      if (needsApproval) {
        const approvalDeadline = new Date(
          Date.now() + row.send_window_minutes * 60_000,
        ).toISOString();
        const scheduleMeta: ScheduleMeta = {
          scheduled_message_id: row.id,
          approval_deadline: approvalDeadline,
          rrule: row.rrule,
          fired_at: row.next_run_at,
        };
        const audienceWithMeta = {
          ...row.audience_spec,
          _schedule: scheduleMeta,
        };

        const { data: msg, error: insErr } = await supa
          .from('messages')
          .insert({
            body_md: row.body_md,
            body_rendered: row.body_md,
            source: 'scheduled',
            status: 'pending_approval',
            audience_spec: audienceWithMeta,
            quick_replies: quickReplies,
            template_id: row.template_id,
            created_by: row.created_by,
            recipient_count: recipientCount,
          })
          .select('id')
          .single();

        if (insErr || !msg) throw new Error(insErr?.message ?? 'message insert failed');

        if (tgToken) {
          notifyOperatorScheduledPending(supa, tgToken, {
            messageId: msg.id,
            recipientCount,
            bodyPreview: row.body_md,
            windowMinutes: row.send_window_minutes,
          }).catch((e) => console.error('scheduled operator notify', e));
        }

        // Reclaim at deadline to auto-skip if operator does not respond.
        await supa
          .from('scheduled_messages')
          .update({
            next_run_at: approvalDeadline,
            locked_at: null,
            locked_by: null,
            last_error: null,
          })
          .eq('id', row.id);

        processed++;
        continue;
      }

      const { data: msg, error: insErr } = await supa
        .from('messages')
        .insert({
          body_md: row.body_md,
          body_rendered: row.body_md,
          source: 'scheduled',
          status: 'draft',
          audience_spec: row.audience_spec,
          quick_replies: quickReplies,
          template_id: row.template_id,
          created_by: row.created_by,
        })
        .select('id')
        .single();

      if (insErr || !msg) throw new Error(insErr?.message ?? 'message insert failed');

      const { error: enqErr } = await supa.rpc('enqueue_message_system', {
        p_message_id: msg.id,
      });
      if (enqErr) {
        await supa.from('messages').delete().eq('id', msg.id);
        throw new Error(enqErr.message);
      }

      notifyExternalEndpointsForMessage(supa, msg.id).catch((e) =>
        console.error('scheduled external notify', e),
      );

      await advanceSchedule(supa, row);
      processed++;
    } catch (e) {
      const msg = String(e).slice(0, 500);
      const nextAttempts = row.dispatch_attempts + 1;
      const failed = nextAttempts >= MAX_DISPATCH_ATTEMPTS;
      await supa
        .from('scheduled_messages')
        .update({
          locked_at: null,
          locked_by: null,
          last_error: msg,
          dispatch_attempts: nextAttempts,
          status: failed ? 'failed' : 'pending',
        })
        .eq('id', row.id);
      console.error('scheduled dispatch row failed', row.id, e);
    }
  }

  return json({ ok: true, processed });
}));
