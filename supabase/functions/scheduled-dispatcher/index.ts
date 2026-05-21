// Drains due scheduled_messages: materializes a messages row, enqueues outbound rows,
// advances recurrence or marks complete. Invoked by pg_cron every minute.
//
// Optional: set CRON_INVOKER_JWT in Edge secrets and send Authorization: Bearer <jwt>
// from cron once Vault-backed headers are wired; otherwise matches send-worker (open POST).

// Use esm.sh instead of npm: — npm specifiers were causing
// "Function failed to start" (BOOT_ERROR) on Supabase's current Deno Edge
// runtime. esm.sh is bundled+cached at edge, much more reliable across
// runtime version bumps.
import { rrulestr } from 'https://esm.sh/rrule@2.8.1';
import { serviceClient, json } from './_shared/supabase.ts';

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

Deno.serve(async (req) => {
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
  const rows = await claimBatch(supa);
  if (!rows.length) return json({ ok: true, processed: 0 });

  let processed = 0;

  for (const row of rows) {
    try {
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
});
