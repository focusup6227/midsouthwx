export const SEVERITY_RANK: Record<string, number> = {
  unknown: 0,
  minor: 1,
  moderate: 2,
  severe: 3,
  extreme: 4,
};

export function severityRank(s: string | null | undefined): number {
  if (!s) return 0;
  return SEVERITY_RANK[s.toLowerCase()] ?? 0;
}

export function severityOk(
  minSeverity: string | null | undefined,
  alertSev: string | null | undefined,
): boolean {
  if (!minSeverity?.trim()) return true;
  return severityRank(alertSev) >= severityRank(minSeverity);
}

export type AlertQueuedPayload = {
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

export type NwsContext = {
  nws_id: string;
  event: string;
  headline: string | null;
  area_desc: string | null;
  expires_at: string | null;
  severity: string | null;
};

export function buildAlertQueuedPayload(input: {
  message_id: string;
  source: string;
  body_md: string;
  audience_count: number;
  nws?: NwsContext | null;
}): AlertQueuedPayload {
  const payload: AlertQueuedPayload = {
    event: 'alert.queued',
    message_id: input.message_id,
    source: input.source,
    body_md: input.body_md,
    audience_count: input.audience_count,
    severity: input.nws?.severity ?? null,
    sent_at: new Date().toISOString(),
  };
  if (input.nws) {
    payload.nws = {
      nws_id: input.nws.nws_id,
      event: input.nws.event,
      headline: input.nws.headline,
      area_desc: input.nws.area_desc,
      expires_at: input.nws.expires_at,
    };
  }
  return payload;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
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
