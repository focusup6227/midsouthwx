'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase/server';

const uuid = z.string().uuid();

function regionFilterJson(regionIds: string[]): Record<string, unknown> | null {
  if (!regionIds.length) return null;
  return { region_ids: regionIds };
}

const RuleSchema = z.object({
  event_pattern: z.string().min(1).max(500),
  min_severity: z.string().max(50),
  mode: z.enum(['auto', 'review', 'ignore']),
  template_id: z.string(),
  region_ids: z.array(z.string().uuid()),
});
type RuleFields = z.infer<typeof RuleSchema>;

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
  return RuleSchema.safeParse(raw);
}

type RuleActionResult = { ok: true } | { error: string };

function resolveRuleFields(
  formData: FormData,
): { error: string } | { data: RuleFields; minSeverity: string | null; templateId: string | null } {
  const parsed = parseRuleForm(formData);
  if (!parsed.success) {
    return { error: 'Check the rule fields — event pattern is required (max 500 chars).' };
  }
  const minSeverity = parsed.data.min_severity.length ? parsed.data.min_severity : null;
  let templateId: string | null = null;
  if (parsed.data.template_id.length) {
    const t = uuid.safeParse(parsed.data.template_id);
    if (!t.success) return { error: 'Invalid template selection.' };
    templateId = t.data;
  }
  if (parsed.data.mode !== 'ignore' && !templateId) {
    return { error: 'Auto and review rules need a template — pick one or set mode to Ignore.' };
  }
  return { data: parsed.data, minSeverity, templateId };
}

export async function createAutoRule(formData: FormData): Promise<RuleActionResult> {
  const fields = resolveRuleFields(formData);
  if ('error' in fields) return fields;

  const supa = supabaseServer();
  const { error } = await supa.from('auto_alert_rules').insert({
    event_pattern: fields.data.event_pattern,
    min_severity: fields.minSeverity,
    mode: fields.data.mode,
    region_filter: regionFilterJson(fields.data.region_ids),
    template_id: fields.templateId,
    enabled: true,
  });
  if (error) {
    console.error('[nws] createAutoRule', error.message);
    return { error: `Could not create rule: ${error.message}` };
  }
  revalidatePath('/nws');
  return { ok: true };
}

export async function updateAutoRule(formData: FormData): Promise<RuleActionResult> {
  const idParse = uuid.safeParse(String(formData.get('rule_id') ?? ''));
  if (!idParse.success) return { error: 'Invalid rule id.' };

  const fields = resolveRuleFields(formData);
  if ('error' in fields) return fields;

  const supa = supabaseServer();
  const { error } = await supa
    .from('auto_alert_rules')
    .update({
      event_pattern: fields.data.event_pattern,
      min_severity: fields.minSeverity,
      mode: fields.data.mode,
      region_filter: regionFilterJson(fields.data.region_ids),
      template_id: fields.templateId,
    })
    .eq('id', idParse.data);

  if (error) {
    console.error('[nws] updateAutoRule', error.message);
    return { error: `Could not save rule: ${error.message}` };
  }
  revalidatePath('/nws');
  return { ok: true };
}

export async function deleteAutoRuleAction(formData: FormData): Promise<RuleActionResult> {
  const idRaw = String(formData.get('id') ?? '');
  const idParse = uuid.safeParse(idRaw);
  if (!idParse.success) return { error: 'Invalid rule id.' };

  const supa = supabaseServer();
  const { error } = await supa.from('auto_alert_rules').delete().eq('id', idParse.data);
  if (error) {
    console.error('[nws] deleteAutoRule', error.message);
    return { error: `Could not delete rule: ${error.message}` };
  }
  revalidatePath('/nws');
  return { ok: true };
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

  const { notifyExternalEndpointsForMessage } = await import('@/lib/integrations/notify');
  notifyExternalEndpointsForMessage(idParse.data).catch(console.error);

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

// Manually invoke the Edge Function for ad-hoc polling/dispatching from the dashboard.
// Useful for testing, post-deploy verification, or "process now" after rule edits.
async function invokeEdgeFunction(
  name: 'nws-poll' | 'nws-dispatcher',
): Promise<{ ok: true; result: unknown } | { error: string }> {
  const supa = supabaseServer();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { error: 'Not signed in' };
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!op) return { error: 'Not an operator' };

  // Use the admin (service_role) client so the call satisfies any future
  // CRON_INVOKER_JWT check, and so it bypasses user-token rate limiting.
  const admin = supabaseAdmin();
  const { data, error } = await admin.functions.invoke(name, { body: {} });
  if (error) return { error: error.message ?? String(error) };
  return { ok: true, result: data };
}

export async function runNwsPoll() {
  const res = await invokeEdgeFunction('nws-poll');
  if ('ok' in res) revalidatePath('/nws');
  return res;
}

export async function runNwsDispatcher() {
  const res = await invokeEdgeFunction('nws-dispatcher');
  if ('ok' in res) revalidatePath('/nws');
  return res;
}
