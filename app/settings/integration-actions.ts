'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { buildAlertQueuedPayload, hmacSha256Hex } from '@/lib/integrations/payload';

const uuid = z.string().uuid();

export const SEVERITY_OPTIONS = ['', 'Minor', 'Moderate', 'Severe', 'Extreme'] as const;

function parseEndpointForm(formData: FormData) {
  const enabledRaw = formData.get('enabled');
  return {
    name: String(formData.get('name') ?? '').trim(),
    url: String(formData.get('url') ?? '').trim(),
    secret: String(formData.get('secret') ?? '').trim(),
    severity_threshold: String(formData.get('severity_threshold') ?? '').trim(),
    enabled: enabledRaw === 'on' || enabledRaw === 'true' || enabledRaw === '1',
  };
}

async function requireOperator() {
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user) throw new Error('not authenticated');
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userRes.user.id)
    .maybeSingle();
  if (!op) throw new Error('operators only');
  return supa;
}

export async function createIntegrationEndpoint(formData: FormData): Promise<void> {
  const raw = parseEndpointForm(formData);
  if (!raw.name || !raw.url) throw new Error('Name and URL are required');

  const supa = await requireOperator();
  const { error } = await supa.from('integration_endpoints').insert({
    name: raw.name,
    url: raw.url,
    secret: raw.secret || null,
    severity_threshold: raw.severity_threshold || null,
    enabled: raw.enabled,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
}

export async function updateIntegrationEndpoint(formData: FormData): Promise<void> {
  const idParse = uuid.safeParse(String(formData.get('id') ?? ''));
  if (!idParse.success) throw new Error('Invalid endpoint id');

  const raw = parseEndpointForm(formData);
  if (!raw.name || !raw.url) throw new Error('Name and URL are required');

  const supa = await requireOperator();
  const patch: Record<string, unknown> = {
    name: raw.name,
    url: raw.url,
    severity_threshold: raw.severity_threshold || null,
    enabled: raw.enabled,
  };
  if (raw.secret) patch.secret = raw.secret;

  const { error } = await supa
    .from('integration_endpoints')
    .update(patch)
    .eq('id', idParse.data);
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
}

export async function deleteIntegrationEndpoint(formData: FormData): Promise<void> {
  const idParse = uuid.safeParse(String(formData.get('id') ?? ''));
  if (!idParse.success) throw new Error('Invalid endpoint id');

  const supa = await requireOperator();
  const { error } = await supa.from('integration_endpoints').delete().eq('id', idParse.data);
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
}

export async function toggleIntegrationEndpoint(
  endpointId: string,
  enabled: boolean,
): Promise<void> {
  const idParse = uuid.safeParse(endpointId);
  if (!idParse.success) throw new Error('Invalid endpoint id');

  const supa = await requireOperator();
  const { error } = await supa
    .from('integration_endpoints')
    .update({ enabled })
    .eq('id', idParse.data);
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
}

export type TestPingResult = {
  ok: boolean;
  results: { endpoint_name: string; status: string; ok: boolean }[];
};

export async function testIntegrationEndpoint(endpointId: string): Promise<TestPingResult> {
  const idParse = uuid.safeParse(endpointId);
  if (!idParse.success) throw new Error('Invalid endpoint id');

  await requireOperator();

  const admin = supabaseAdmin();
  const { data: ep } = await admin
    .from('integration_endpoints')
    .select('id, name, url, secret')
    .eq('id', idParse.data)
    .single();

  if (!ep) throw new Error('Endpoint not found');

  const payload = buildAlertQueuedPayload({
    message_id: '00000000-0000-0000-0000-000000000000',
    source: 'manual',
    body_md: 'Mid-South WX test ping — ignore this alert.',
    audience_count: 0,
  });

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'MidSouthWX/1.0',
  };
  if (ep.secret) {
    headers['x-midsouthwx-signature'] = `sha256=${await hmacSha256Hex(ep.secret, body)}`;
  }

  try {
    const res = await fetch(ep.url, { method: 'POST', headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* plain text */
    }
    const status = res.ok ? 'sent' : `http_${res.status}`;
    await admin.from('external_delivery_logs').insert({
      endpoint_id: ep.id,
      message_id: null,
      status,
      response: { status: res.status, body: parsed, test: true },
    });
    revalidatePath('/settings');
    return {
      ok: res.ok,
      results: [{ endpoint_name: ep.name, status, ok: res.ok }],
    };
  } catch (e) {
    const err = String(e).slice(0, 500);
    await admin.from('external_delivery_logs').insert({
      endpoint_id: ep.id,
      message_id: null,
      status: 'failed',
      response: { error: err, test: true },
    });
    revalidatePath('/settings');
    return {
      ok: false,
      results: [{ endpoint_name: ep.name, status: 'failed', ok: false }],
    };
  }
}
