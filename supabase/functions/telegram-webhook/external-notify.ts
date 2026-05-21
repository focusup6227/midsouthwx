import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const SEVERITY_RANK: Record<string, number> = {
  unknown: 0,
  minor: 1,
  moderate: 2,
  severe: 3,
  extreme: 4,
};

function severityRank(s: string | null | undefined): number {
  if (!s) return 0;
  return SEVERITY_RANK[s.toLowerCase()] ?? 0;
}

function severityOk(
  minSeverity: string | null | undefined,
  alertSev: string | null | undefined,
): boolean {
  if (!minSeverity?.trim()) return true;
  return severityRank(alertSev) >= severityRank(minSeverity);
}

type AlertQueuedPayload = {
  event: 'alert.queued';
  message_id: string;
  source: string;
  body_md: string;
  audience_count: number;
  severity: string | null;
  sent_at: string;
  nws?: {
    nws_id: string;
    event: string;
    headline: string | null;
    area_desc: string | null;
    expires_at: string | null;
  };
};

type IntegrationEndpoint = {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  severity_threshold: string | null;
};

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function logDelivery(
  supa: SupabaseClient,
  endpointId: string,
  messageId: string,
  status: string,
  response: unknown,
) {
  await supa.from('external_delivery_logs').insert({
    endpoint_id: endpointId,
    message_id: messageId,
    status,
    response,
  });
}

export async function notifyExternalEndpointsForMessage(
  supa: SupabaseClient,
  messageId: string,
): Promise<void> {
  const { data: msg, error: msgErr } = await supa
    .from('messages')
    .select('id, body_md, source, recipient_count, nws_alert_id')
    .eq('id', messageId)
    .single();

  if (msgErr || !msg) {
    console.error('[external-notify] message not found', messageId);
    return;
  }

  let nwsSeverity: string | null = null;
  let nwsBlock: AlertQueuedPayload['nws'];
  if (msg.nws_alert_id) {
    const { data: alert } = await supa
      .from('nws_alerts')
      .select('nws_id, event, headline, area_desc, expires_at, severity')
      .eq('id', msg.nws_alert_id)
      .maybeSingle();
    if (alert) {
      nwsSeverity = alert.severity;
      nwsBlock = {
        nws_id: alert.nws_id,
        event: alert.event,
        headline: alert.headline,
        area_desc: alert.area_desc,
        expires_at: alert.expires_at,
      };
    }
  }

  const payload: AlertQueuedPayload = {
    event: 'alert.queued',
    message_id: msg.id,
    source: msg.source,
    body_md: msg.body_md,
    audience_count: msg.recipient_count ?? 0,
    severity: nwsSeverity,
    sent_at: new Date().toISOString(),
    nws: nwsBlock,
  };

  const { data: endpoints, error } = await supa
    .from('integration_endpoints')
    .select('id, name, url, secret, severity_threshold')
    .eq('enabled', true);

  if (error) {
    console.error('[external-notify] load endpoints', error.message);
    return;
  }

  const eligible = (endpoints ?? []).filter((ep) =>
    severityOk(ep.severity_threshold, payload.severity),
  ) as IntegrationEndpoint[];

  await Promise.allSettled(
    eligible.map(async (ep) => {
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
        await logDelivery(supa, ep.id, messageId, status, { status: res.status, body: parsed });
      } catch (e) {
        await logDelivery(supa, ep.id, messageId, 'failed', { error: String(e).slice(0, 500) });
      }
    }),
  );
}
