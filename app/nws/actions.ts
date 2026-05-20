'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { supabaseServer } from '@/lib/supabase/server';

const uuid = z.string().uuid();

function regionFilterJson(regionIds: string[]): Record<string, unknown> | null {
  if (!regionIds.length) return null;
  return { region_ids: regionIds };
}

function parseRuleForm(formData: FormData) {
  const region_ids = formData
    .getAll('region_ids')
    .map((v) => String(v))
    .filter(Boolean);
  const raw = {
    event_pattern: String(formData.get('event_pattern') ?? '').trim(),
    min_severity: String(formData.get('min_severity') ?? '').trim(),
    mode: String(formData.get('mode') ?? 'review'),
    template_id: String(formData.get('template_id') ?? '').trim(),
    region_ids,
  };
  const Schema = z.object({
    event_pattern: z.string().min(1).max(500),
    min_severity: z.string().max(50),
    mode: z.enum(['auto', 'review', 'ignore']),
    template_id: z.string(),
    region_ids: z.array(z.string().uuid()),
  });
  return Schema.safeParse(raw);
}

export async function createAutoRule(formData: FormData): Promise<void> {
  const parsed = parseRuleForm(formData);
  if (!parsed.success) {
    console.warn('[nws] createAutoRule validation failed');
    return;
  }
  const minSeverity = parsed.data.min_severity.length ? parsed.data.min_severity : null;
  let templateId: string | null = null;
  if (parsed.data.template_id.length) {
    const t = uuid.safeParse(parsed.data.template_id);
    if (!t.success) {
      console.warn('[nws] createAutoRule invalid template id');
      return;
    }
    templateId = t.data;
  }
  if (parsed.data.mode !== 'ignore' && !templateId) {
    console.warn('[nws] createAutoRule template required for auto/review');
    return;
  }

  const supa = supabaseServer();
  const { error } = await supa.from('auto_alert_rules').insert({
    event_pattern: parsed.data.event_pattern,
    min_severity: minSeverity,
    mode: parsed.data.mode,
    region_filter: regionFilterJson(parsed.data.region_ids),
    template_id: templateId,
    enabled: true,
  });
  if (error) {
    console.error('[nws] createAutoRule', error.message);
    return;
  }
  revalidatePath('/nws');
}

export async function updateAutoRule(formData: FormData): Promise<void> {
  const idParse = uuid.safeParse(String(formData.get('rule_id') ?? ''));
  if (!idParse.success) {
    console.warn('[nws] updateAutoRule invalid rule id');
    return;
  }

  const parsed = parseRuleForm(formData);
  if (!parsed.success) {
    console.warn('[nws] updateAutoRule validation failed');
    return;
  }
  const minSeverity = parsed.data.min_severity.length ? parsed.data.min_severity : null;
  let templateId: string | null = null;
  if (parsed.data.template_id.length) {
    const t = uuid.safeParse(parsed.data.template_id);
    if (!t.success) {
      console.warn('[nws] updateAutoRule invalid template id');
      return;
    }
    templateId = t.data;
  }
  if (parsed.data.mode !== 'ignore' && !templateId) {
    console.warn('[nws] updateAutoRule template required for auto/review');
    return;
  }

  const supa = supabaseServer();
  const { error } = await supa
    .from('auto_alert_rules')
    .update({
      event_pattern: parsed.data.event_pattern,
      min_severity: minSeverity,
      mode: parsed.data.mode,
      region_filter: regionFilterJson(parsed.data.region_ids),
      template_id: templateId,
    })
    .eq('id', idParse.data);

  if (error) {
    console.error('[nws] updateAutoRule', error.message);
    return;
  }
  revalidatePath('/nws');
}

export async function deleteAutoRuleAction(formData: FormData): Promise<void> {
  const idRaw = String(formData.get('id') ?? '');
  const idParse = uuid.safeParse(idRaw);
  if (!idParse.success) {
    console.warn('[nws] deleteAutoRule invalid id');
    return;
  }

  const supa = supabaseServer();
  const { error } = await supa.from('auto_alert_rules').delete().eq('id', idParse.data);
  if (error) {
    console.error('[nws] deleteAutoRule', error.message);
    return;
  }
  revalidatePath('/nws');
}

export async function setAutoRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
  const idParse = uuid.safeParse(ruleId);
  if (!idParse.success) {
    console.warn('[nws] setAutoRuleEnabled invalid id');
    return;
  }

  const supa = supabaseServer();
  const { error } = await supa.from('auto_alert_rules').update({ enabled }).eq('id', idParse.data);
  if (error) {
    console.error('[nws] setAutoRuleEnabled', error.message);
    return;
  }
  revalidatePath('/nws');
}

export async function approveNwsMessage(messageId: string) {
  const idParse = uuid.safeParse(messageId);
  if (!idParse.success) return { error: 'Invalid message id' };

  const supa = supabaseServer();
  const { data: msg, error: fetchErr } = await supa
    .from('messages')
    .select('id, source, status')
    .eq('id', idParse.data)
    .single();

  if (fetchErr || !msg) return { error: 'Message not found' };
  if (msg.source !== 'nws' || msg.status !== 'pending_approval') {
    return { error: 'Only pending NWS messages can be approved' };
  }

  const { error } = await supa.rpc('enqueue_message', { p_message_id: idParse.data });
  if (error) return { error: error.message };
  revalidatePath('/nws');
  revalidatePath(`/alerts/${idParse.data}`);
  return { ok: true as const };
}

export async function rejectNwsMessage(messageId: string) {
  const idParse = uuid.safeParse(messageId);
  if (!idParse.success) return { error: 'Invalid message id' };

  const supa = supabaseServer();
  const { data: msg, error: fetchErr } = await supa
    .from('messages')
    .select('id, source, status')
    .eq('id', idParse.data)
    .single();

  if (fetchErr || !msg) return { error: 'Message not found' };
  if (msg.source !== 'nws' || msg.status !== 'pending_approval') {
    return { error: 'Only pending NWS messages can be rejected' };
  }

  const { error } = await supa
    .from('messages')
    .update({ status: 'cancelled' })
    .eq('id', idParse.data);

  if (error) return { error: error.message };
  revalidatePath('/nws');
  revalidatePath(`/alerts/${idParse.data}`);
  return { ok: true as const };
}
