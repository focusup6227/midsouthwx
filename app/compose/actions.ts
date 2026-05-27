'use server';

import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const AudienceSpec = z.object({
  all: z.boolean().optional(),
  regions: z.array(z.string().uuid()).optional(),
  groups: z.array(z.string().uuid()).optional(),
  subscribers: z.array(z.string().uuid()).optional(),
  geometry: z.any().optional(), // circle or GeoJSON geometry for radar selections
});

const QuickReply = z.object({ label: z.string().min(1), data: z.string().min(1) });

const TemplateVars = z
  .object({
    headline: z.string().optional(),
    event: z.string().optional(),
    area_desc: z.string().optional(),
    expires_at: z.string().optional(),
  })
  .optional();

const MediaInput = z
  .object({
    url: z.string().url(),
    type: z.enum(['animation', 'photo', 'video', 'document']),
  })
  .nullable()
  .optional();

const SendInput = z.object({
  body_md: z.string().min(1, 'Body cannot be empty'),
  audience_spec: AudienceSpec,
  quick_replies: z.array(QuickReply),
  template_id: z.string().uuid().nullable(),
  source: z.enum(['manual', 'checkin']),
  template_vars: TemplateVars,
  media: MediaInput,
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

  // Operator gate via RLS-respecting client.
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) throw new Error('not authenticated');
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!op) throw new Error('operators only');

  // Use service-role for the write path. enqueue_message and enqueue_message_system
  // both require INSERT into outbound_queue, which has no operator-INSERT policy
  // by design (the queue is meant to be filled by privileged code only). Using
  // admin here avoids depending on enqueue_message being SECURITY DEFINER on the
  // remote — and we've already verified operator status above.
  const admin = supabaseAdmin();

  const { fillTemplate } = await import('@/lib/templates/fill');
  const vars = parsed.template_vars;
  const bodyRendered = fillTemplate(parsed.body_md, {
    headline: vars?.headline,
    event: vars?.event,
    areaDesc: vars?.area_desc,
    expiresAt: vars?.expires_at,
  });

  const { data: msg, error: insertErr } = await admin
    .from('messages')
    .insert({
      body_md: parsed.body_md,
      body_rendered: bodyRendered,
      source: parsed.source,
      status: 'draft',
      audience_spec: parsed.audience_spec,
      quick_replies: parsed.quick_replies.length ? parsed.quick_replies : null,
      template_id: parsed.template_id,
      created_by: userId,
      media_url: parsed.media?.url ?? null,
      media_type: parsed.media?.type ?? null,
    })
    .select('id')
    .single();

  if (insertErr || !msg) throw new Error(insertErr?.message ?? 'insert failed');

  // Auto-attach a polygon snapshot for radar-drawn (geometry) alerts when
  // the operator didn't already upload their own media. Synchronous so the
  // media_url is set before enqueue → the worker reads it at claim time.
  // Renderer failure is swallowed (helper returns null) — alert still sends
  // as text-only.
  if (!parsed.media && parsed.audience_spec.geometry) {
    const { renderComposeSnapshot } = await import('@/lib/snapshot/compose-snapshot');
    const snapshotUrl = await renderComposeSnapshot(msg.id, parsed.audience_spec.geometry, {
      event: parsed.template_vars?.event,
    });
    if (snapshotUrl) {
      await admin
        .from('messages')
        .update({ media_url: snapshotUrl, media_type: 'photo' })
        .eq('id', msg.id);
    }
  }

  const { data: count, error: enqErr } = await admin.rpc('enqueue_message_system', {
    p_message_id: msg.id,
  });
  if (enqErr) {
    await admin.from('messages').update({ status: 'failed' }).eq('id', msg.id);
    throw new Error(enqErr.message);
  }

  const { notifyExternalEndpointsForMessage } = await import('@/lib/integrations/notify');
  notifyExternalEndpointsForMessage(msg.id).catch((e) =>
    console.error('[compose] external notify', e),
  );

  revalidatePath('/dashboard');
  revalidatePath('/alerts');
  return { id: msg.id, count: count as unknown as number };
}

export async function sendAndRedirect(input: z.infer<typeof SendInput>): Promise<never> {
  const res = await sendNow(input);
  redirect(`/alerts/${res.id}`);
}

export type DraftTone = 'urgent-calm' | 'technical' | 'brief';
export type DraftContext = 'nws' | 'thread' | 'raw';

export async function draftWithAI(params: {
  context: DraftContext;
  tone: DraftTone;
  sourceText: string;
}): Promise<{ body_md: string; quick_replies: { label: string; data: string }[] | null }> {
  const { generateDraft } = await import('@/lib/ai/draft');
  const result = await generateDraft(params);
  return result;
}
