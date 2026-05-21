import { rrulestr } from 'https://esm.sh/rrule@2.8.1';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

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

export async function advanceScheduleAfterSend(
  supa: SupabaseClient,
  scheduleId: string,
  rrule: string | null,
  firedAt: string,
) {
  if (rrule?.trim()) {
    const nextIso = computeNextIso(rrule, firedAt);
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
        .eq('id', scheduleId);
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
        .eq('id', scheduleId);
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
      .eq('id', scheduleId);
  }
}

export function scheduleMetaFromAudience(
  audienceSpec: Record<string, unknown> | null,
): ScheduleMeta | null {
  const meta = (audienceSpec as { _schedule?: ScheduleMeta })?._schedule;
  if (!meta?.scheduled_message_id) return null;
  return meta;
}
