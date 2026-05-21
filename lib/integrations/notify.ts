import { supabaseAdmin } from '@/lib/supabase/server';
import {
  buildAlertQueuedPayload,
  hmacSha256Hex,
  severityOk,
  type AlertQueuedPayload,
  type NwsContext,
} from './payload';

type IntegrationEndpoint = {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  severity_threshold: string | null;
  enabled: boolean;
};

export type NotifyResult = {
  endpoint_id: string;
  endpoint_name: string;
  status: string;
  ok: boolean;
};

async function logDelivery(
  admin: ReturnType<typeof supabaseAdmin>,
  endpointId: string,
  messageId: string | null,
  status: string,
  response: unknown,
) {
  await admin.from('external_delivery_logs').insert({
    endpoint_id: endpointId,
    message_id: messageId,
    status,
    response: response as Record<string, unknown> | null,
  });
}

async function postToEndpoint(
  endpoint: IntegrationEndpoint,
  payload: AlertQueuedPayload,
  messageId: string | null,
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<NotifyResult> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'MidSouthWX/1.0',
  };
  if (endpoint.secret) {
    headers['x-midsouthwx-signature'] = `sha256=${await hmacSha256Hex(endpoint.secret, body)}`;
  }

  try {
    const res = await fetch(endpoint.url, { method: 'POST', headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* plain text response */
    }
    const status = res.ok ? 'sent' : `http_${res.status}`;
    await logDelivery(admin, endpoint.id, messageId, status, {
      status: res.status,
      body: parsed,
    });
    return {
      endpoint_id: endpoint.id,
      endpoint_name: endpoint.name,
      status,
      ok: res.ok,
    };
  } catch (e) {
    const err = String(e).slice(0, 500);
    await logDelivery(admin, endpoint.id, messageId, 'failed', { error: err });
    return {
      endpoint_id: endpoint.id,
      endpoint_name: endpoint.name,
      status: 'failed',
      ok: false,
    };
  }
}

export async function notifyExternalEndpointsWithPayload(
  payload: AlertQueuedPayload,
  opts?: { messageId?: string | null; severity?: string | null },
): Promise<NotifyResult[]> {
  const admin = supabaseAdmin();
  const { data: endpoints, error } = await admin
    .from('integration_endpoints')
    .select('id, name, url, secret, severity_threshold, enabled')
    .eq('enabled', true);

  if (error) {
    console.error('[external-notify] load endpoints', error.message);
    return [];
  }

  const severity = opts?.severity ?? payload.severity;
  const eligible = (endpoints ?? []).filter((ep) =>
    severityOk(ep.severity_threshold, severity),
  ) as IntegrationEndpoint[];

  if (!eligible.length) return [];

  const results = await Promise.allSettled(
    eligible.map((ep) => postToEndpoint(ep, payload, opts?.messageId ?? payload.message_id, admin)),
  );

  const out: NotifyResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') out.push(r.value);
    else console.error('[external-notify] post failed', r.reason);
  }

  const failures = out.filter((r) => !r.ok);
  if (failures.length) {
    await notifyOperatorWebhookFailures(failures, payload.message_id);
  }

  return out;
}

async function notifyOperatorWebhookFailures(failures: NotifyResult[], messageId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const opChatId = Number(process.env.OPERATOR_TELEGRAM_CHAT_ID ?? 0);
  if (!token || !opChatId) return;

  const names = failures.map((f) => f.endpoint_name).join(', ');
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: opChatId,
      text: `⚠️ External webhook failure for alert ${messageId.slice(0, 8)}… — ${names}`,
    }),
  }).catch((e) => console.error('[external-notify] operator DM failed', e));
}

export async function notifyExternalEndpointsForMessage(messageId: string): Promise<NotifyResult[]> {
  const admin = supabaseAdmin();

  const { data: msg, error: msgErr } = await admin
    .from('messages')
    .select('id, body_md, source, recipient_count, nws_alert_id')
    .eq('id', messageId)
    .single();

  if (msgErr || !msg) {
    console.error('[external-notify] message not found', messageId, msgErr?.message);
    return [];
  }

  let nws: NwsContext | null = null;
  if (msg.nws_alert_id) {
    const { data: alert } = await admin
      .from('nws_alerts')
      .select('nws_id, event, headline, area_desc, expires_at, severity')
      .eq('id', msg.nws_alert_id)
      .maybeSingle();
    if (alert) nws = alert;
  }

  const payload = buildAlertQueuedPayload({
    message_id: msg.id,
    source: msg.source,
    body_md: msg.body_md,
    audience_count: msg.recipient_count ?? 0,
    nws,
  });

  return notifyExternalEndpointsWithPayload(payload, {
    messageId: msg.id,
    severity: nws?.severity ?? null,
  });
}

/** @deprecated use notifyExternalEndpointsForMessage */
export async function notifyExternalEndpoints(payload: {
  message_id: string;
  body: string;
  audience_count: number;
  severity?: string;
  source: string;
}) {
  return notifyExternalEndpointsWithPayload(
    buildAlertQueuedPayload({
      message_id: payload.message_id,
      source: payload.source,
      body_md: payload.body,
      audience_count: payload.audience_count,
      nws: payload.severity
        ? {
            nws_id: '',
            event: '',
            headline: null,
            area_desc: null,
            expires_at: null,
            severity: payload.severity,
          }
        : null,
    }),
    { messageId: payload.message_id, severity: payload.severity ?? null },
  );
}
