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

// Life-safety convective warnings that ring loud even inside a subscriber's
// quiet hours. Deliberately narrower than "any warning": a Winter Storm or
// High Wind Warning is not worth waking someone at 3 AM, but a tornado
// bearing down is. Match the SQL/TS hazard classifier semantics
// (tornado / severe thunderstorm / flash flood).
function isLifeSafetyWarning(event: string | null): boolean {
  const e = (event ?? '').toLowerCase();
  if (!e.includes('warning')) return false;
  return (
    e.includes('tornado') ||
    e.includes('severe thunderstorm') ||
    e.includes('flash flood')
  );
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

// 'send' rings loud (normal notification); 'silent' delivers with Telegram's
// disable_notification flag so the message still lands immediately but makes
// no sound/vibration — used for non-life-safety alerts inside quiet hours.
export type DeliveryDecision = 'send' | 'silent';

export function deliveryDecision(input: {
  messageSource: string;
  nwsEvent: string | null;
  quietHours: unknown;
}): DeliveryDecision {
  // Operator-authored DMs and check-in pings are always intentional and
  // time-sensitive — they ring through regardless of quiet hours.
  if (input.messageSource === 'manual' || input.messageSource === 'checkin') {
    return 'send';
  }

  // Tornado / Severe Thunderstorm / Flash Flood Warnings are life-safety:
  // they ring loud even inside quiet hours.
  if (isLifeSafetyWarning(input.nwsEvent)) return 'send';

  // Everything else — watches, advisories, statements, non-convective
  // warnings (Winter Storm, Wind, Heat …), scheduled sends, recaps — rings
  // normally outside quiet hours but is delivered silently inside them. It
  // still arrives immediately; it just won't make a sound at 3 AM. (We no
  // longer defer these: deferral risked dropping time-relevant context, and
  // a silent DM the subscriber sees on wake is more useful than a delayed one.)
  const qh = parseQuietHours(input.quietHours);
  if (inQuietHours(qh)) return 'silent';

  return 'send';
}
