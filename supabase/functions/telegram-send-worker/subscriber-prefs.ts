// Mirror of lib/subscribers/prefs.ts for send-worker quiet-hour deferral.

export type AlertPreferences = {
  warnings: boolean;
  watches: boolean;
  advisories: boolean;
  statements: boolean;
};

export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
};

const DEFAULT_QUIET: QuietHours = {
  enabled: false,
  start: '22:00',
  end: '07:00',
  timezone: 'America/Chicago',
};

export function parseQuietHours(raw: unknown): QuietHours {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_QUIET };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    start: typeof o.start === 'string' ? o.start : DEFAULT_QUIET.start,
    end: typeof o.end === 'string' ? o.end : DEFAULT_QUIET.end,
    timezone: typeof o.timezone === 'string' ? o.timezone : DEFAULT_QUIET.timezone,
  };
}

function nwsEventCategory(event: string | null): string {
  const e = (event ?? '').toLowerCase();
  if (e.includes('warning')) return 'warnings';
  if (e.includes('watch')) return 'watches';
  if (e.includes('advisory')) return 'advisories';
  if (e.includes('statement')) return 'statements';
  return 'other';
}

function isWarningClass(event: string | null): boolean {
  return nwsEventCategory(event) === 'warnings';
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

function inQuietHours(qh: QuietHours, at: Date = new Date()): boolean {
  if (!qh.enabled) return false;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: qh.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const nowM = hour * 60 + minute;
  const startM = parseHm(qh.start);
  const endM = parseHm(qh.end);
  if (startM <= endM) return nowM >= startM && nowM < endM;
  return nowM >= startM || nowM < endM;
}

export type DeliveryDecision = 'send' | 'defer';

export function deliveryDecision(input: {
  messageSource: string;
  nwsEvent: string | null;
  quietHours: unknown;
}): DeliveryDecision {
  if (input.messageSource === 'manual' || input.messageSource === 'checkin') {
    return 'send';
  }

  const qh = parseQuietHours(input.quietHours);
  if (!qh.enabled || isWarningClass(input.nwsEvent)) return 'send';

  if (input.messageSource === 'scheduled' || input.messageSource === 'nws') {
    if (inQuietHours(qh)) return 'defer';
  }

  return 'send';
}

export function deferThirtyMinutes(): string {
  return new Date(Date.now() + 30 * 60_000).toISOString();
}
