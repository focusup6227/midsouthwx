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

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = {
  warnings: true,
  watches: true,
  advisories: true,
  statements: false,
};

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  start: '22:00',
  end: '07:00',
  timezone: 'America/Chicago',
};

export function parseAlertPreferences(raw: unknown): AlertPreferences {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    warnings: o.warnings !== false,
    watches: o.watches !== false,
    advisories: o.advisories !== false,
    statements: o.statements === true,
  };
}

export function parseQuietHours(raw: unknown): QuietHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!o.enabled) return { ...DEFAULT_QUIET_HOURS, enabled: false };
  return {
    enabled: true,
    start: typeof o.start === 'string' ? o.start : DEFAULT_QUIET_HOURS.start,
    end: typeof o.end === 'string' ? o.end : DEFAULT_QUIET_HOURS.end,
    timezone: typeof o.timezone === 'string' ? o.timezone : DEFAULT_QUIET_HOURS.timezone,
  };
}

export function nwsEventCategory(event: string | null | undefined): keyof AlertPreferences | 'other' {
  const e = (event ?? '').toLowerCase();
  if (e.includes('warning')) return 'warnings';
  if (e.includes('watch')) return 'watches';
  if (e.includes('advisory')) return 'advisories';
  if (e.includes('statement')) return 'statements';
  return 'other';
}

export function isWarningClass(event: string | null | undefined): boolean {
  return nwsEventCategory(event) === 'warnings';
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

export function inQuietHours(qh: QuietHours | null, at: Date = new Date()): boolean {
  if (!qh?.enabled) return false;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: qh.timezone || DEFAULT_QUIET_HOURS.timezone,
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

/** When quiet hours end (next send_after) in UTC ISO string. */
export function quietHoursEndIso(qh: QuietHours, at: Date = new Date()): string {
  const tz = qh.timezone || DEFAULT_QUIET_HOURS.timezone;
  const endM = parseHm(qh.end);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const y = parseInt(get('year'), 10);
  const mo = parseInt(get('month'), 10) - 1;
  const d = parseInt(get('day'), 10);
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const nowM = hour * 60 + minute;

  let dayOffset = 0;
  if (nowM < endM && parseHm(qh.start) > parseHm(qh.end)) {
    // overnight window, still before end today
    dayOffset = 0;
  } else if (nowM >= parseHm(qh.start) && parseHm(qh.start) > parseHm(qh.end)) {
    dayOffset = 1;
  } else if (nowM >= endM) {
    dayOffset = 1;
  }

  const endHour = Math.floor(endM / 60);
  const endMin = endM % 60;
  const local = new Date(Date.UTC(y, mo, d + dayOffset, endHour, endMin));
  // Approximate: use formatter reverse — simpler defer +30min loop until out of quiet
  // For reliability in Edge, defer 30 minutes and let worker retry.
  return new Date(at.getTime() + 30 * 60_000).toISOString();
}

export type DeliveryDecision = 'send' | 'defer' | 'skip';

export function deliveryDecision(input: {
  messageSource: string;
  nwsEvent: string | null;
  alertPreferences: unknown;
  quietHours: unknown;
}): DeliveryDecision {
  const prefs = parseAlertPreferences(input.alertPreferences);
  const qh = parseQuietHours(input.quietHours);

  if (input.messageSource === 'manual' || input.messageSource === 'checkin') {
    return 'send';
  }

  if (input.messageSource === 'nws' && input.nwsEvent) {
    const cat = nwsEventCategory(input.nwsEvent);
    if (cat !== 'other' && !prefs[cat]) return 'skip';
  }

  if (qh?.enabled && !isWarningClass(input.nwsEvent)) {
    if (input.messageSource === 'scheduled' || input.messageSource === 'nws') {
      if (inQuietHours(qh)) return 'defer';
    }
  }

  return 'send';
}

export function formatPrefsSummary(prefs: AlertPreferences, qh: QuietHours | null): string {
  const lines = [
    `Warnings: ${prefs.warnings ? 'ON' : 'off'}`,
    `Watches: ${prefs.watches ? 'ON' : 'off'}`,
    `Advisories: ${prefs.advisories ? 'ON' : 'off'}`,
    `Statements: ${prefs.statements ? 'ON' : 'off'}`,
  ];
  if (qh?.enabled) {
    lines.push(`Quiet hours: ${qh.start}–${qh.end} ${qh.timezone} (warnings still come through)`);
  } else {
    lines.push('Quiet hours: off');
  }
  return lines.join('\n');
}
