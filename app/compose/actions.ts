'use server';

import { supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const AudienceSpec = z.object({
  all: z.boolean().optional(),
  regions: z.array(z.string().uuid()).optional(),
  groups: z.array(z.string().uuid()).optional(),
  subscribers: z.array(z.string().uuid()).optional(),
});

const QuickReply = z.object({ label: z.string().min(1), data: z.string().min(1) });

const SendInput = z.object({
  body_md: z.string().min(1, 'Body cannot be empty'),
  audience_spec: AudienceSpec,
  quick_replies: z.array(QuickReply),
  template_id: z.string().uuid().nullable(),
  source: z.enum(['manual', 'checkin']),
});

export type AudienceSpecT = z.infer<typeof AudienceSpec>;

export async function previewAudience(spec: AudienceSpecT): Promise<number> {
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('resolve_audience', { spec });
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

export async function sendNow(input: z.infer<typeof SendInput>): Promise<{ id: string; count: number }> {
  const parsed = SendInput.parse(input);
  const supa = supabaseServer();

  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) throw new Error('not authenticated');

  const { data: msg, error: insertErr } = await supa
    .from('messages')
    .insert({
      body_md: parsed.body_md,
      body_rendered: parsed.body_md,
      source: parsed.source,
      status: 'draft',
      audience_spec: parsed.audience_spec,
      quick_replies: parsed.quick_replies.length ? parsed.quick_replies : null,
      template_id: parsed.template_id,
      created_by: userId,
    })
    .select('id')
    .single();

  if (insertErr || !msg) throw new Error(insertErr?.message ?? 'insert failed');

  const { data: count, error: enqErr } = await supa.rpc('enqueue_message', { p_message_id: msg.id });
  if (enqErr) {
    await supa.from('messages').update({ status: 'failed' }).eq('id', msg.id);
    throw new Error(enqErr.message);
  }

  revalidatePath('/dashboard');
  revalidatePath('/alerts');
  return { id: msg.id, count: count as unknown as number };
}

export async function sendAndRedirect(input: z.infer<typeof SendInput>): Promise<never> {
  const res = await sendNow(input);
  redirect(`/alerts/${res.id}`);
}
