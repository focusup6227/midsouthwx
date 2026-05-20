'use server';

import { buildWeeklyRruleIc } from '@/lib/schedule/weekly-rrule';
import { supabaseServer } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

const AudienceSpec = z.object({
  all: z.boolean().optional(),
  regions: z.array(z.string().uuid()).optional(),
  groups: z.array(z.string().uuid()).optional(),
  subscribers: z.array(z.string().uuid()).optional(),
});

export type AudienceSpecT = z.infer<typeof AudienceSpec>;

export async function previewAudienceSchedule(spec: AudienceSpecT): Promise<number> {
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('resolve_audience', { spec });
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

const SchedulePayload = z.object({
  body_md: z.string().min(1),
  audience_spec: AudienceSpec,
  template_id: z.string().uuid().nullable(),
  scheduled_for_iso: z.string().min(1),
  recurrence: z.enum(['none', 'weekly']),
});

export type SchedulePayloadT = z.infer<typeof SchedulePayload>;

export async function createSchedule(input: SchedulePayloadT) {
  const parsed = SchedulePayload.parse(input);
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) throw new Error('not authenticated');

  const start = new Date(parsed.scheduled_for_iso);
  if (Number.isNaN(start.getTime())) throw new Error('invalid schedule time');

  const rrule = parsed.recurrence === 'weekly' ? buildWeeklyRruleIc(start) : null;

  const { error } = await supa.from('scheduled_messages').insert({
    body_md: parsed.body_md,
    audience_spec: parsed.audience_spec,
    scheduled_for: start.toISOString(),
    rrule,
    template_id: parsed.template_id,
    created_by: userId,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/schedule');
}

export async function updateSchedule(id: string, input: SchedulePayloadT) {
  const parsed = SchedulePayload.parse(input);
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user?.id) throw new Error('not authenticated');

  const start = new Date(parsed.scheduled_for_iso);
  if (Number.isNaN(start.getTime())) throw new Error('invalid schedule time');

  const rrule = parsed.recurrence === 'weekly' ? buildWeeklyRruleIc(start) : null;

  const { data, error } = await supa
    .from('scheduled_messages')
    .update({
      body_md: parsed.body_md,
      audience_spec: parsed.audience_spec,
      scheduled_for: start.toISOString(),
      rrule,
      template_id: parsed.template_id,
      status: 'pending',
      locked_at: null,
      locked_by: null,
      last_error: null,
      dispatch_attempts: 0,
    })
    .eq('id', id)
    .in('status', ['pending', 'failed'])
    .select('id');

  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error('Schedule not found or is no longer editable.');
  revalidatePath('/schedule');
  revalidatePath(`/schedule/${id}`);
}

export async function cancelSchedule(id: string) {
  const supa = supabaseServer();
  const { error } = await supa
    .from('scheduled_messages')
    .update({
      status: 'cancelled',
      locked_at: null,
      locked_by: null,
    })
    .eq('id', id);

  if (error) throw new Error(error.message);
  revalidatePath('/schedule');
}

export async function createScheduleAndRedirect(input: SchedulePayloadT) {
  await createSchedule(input);
  redirect('/schedule');
}

export async function updateScheduleAndRedirect(id: string, input: SchedulePayloadT) {
  await updateSchedule(id, input);
  redirect('/schedule');
}
