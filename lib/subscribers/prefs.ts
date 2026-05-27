// F6: hazard kinds a subscriber can opt out of (e.g. "don't send me flood
// warnings"). Must match the SQL `nws_event_hazard()` heuristics in
// supabase/migrations/20260601000002_subscriber_hazard_prefs.sql AND
// classifyNwsEvent() in lib/nws/radar.ts — these three places are the
// canonical hazard vocabulary and have to move together.
export const HAZARD_KINDS = ['tornado', 'severe', 'flood', 'winter', 'heat', 'wind'] as const;
export type HazardKind = typeof HAZARD_KINDS[number];

export type AlertPreferences = {
  warnings: boolean;
  watches: boolean;
  advisories: boolean;
  statements: boolean;
  skip_hazards: HazardKind[];
  // F-aggregation: when false, the send worker skips outbreak aggregation
  // for this subscriber. Subscribers toggle it via /prefs in Telegram.
  aggregate_warnings: boolean;
};

export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
};

// Conservative defaults: only Warnings (highest urgency) ship by default so
// a brand-new subscriber doesn't get blasted with watches/advisories before
// they understand the bot. The Telegram onboarding flow nudges them to opt
// into watches if they want a heads-up before warnings arrive.
export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = {
  warnings: true,
  watches: false,
  advisories: false,
  statements: false,
  skip_hazards: [],
  aggregate_warnings: true,
};

export function isHazardKind(x: unknown): x is HazardKind {
  return typeof x === 'string' && (HAZARD_KINDS as readonly string[]).includes(x);
}

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  start: '22:00',
  end: '07:00',
  timezone: 'America/Chicago',
};

export function parseAlertPreferences(raw: unknown): AlertPreferences {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawHazards = Array.isArray(o.skip_hazards) ? o.skip_hazards : [];
  const skip_hazards = rawHazards.filter(isHazardKind);
  return {
    warnings: o.warnings !== false,
    watches: o.watches !== false,
    advisories: o.advisories !== false,
    statements: o.statements === true,
    skip_hazards,
    aggregate_warnings: o.aggregate_warnings !== false,
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

export function nwsEventCategory(event: string | null | undefined): 'warnings' | 'watches' | 'advisories' | 'statements' | 'other' {
  const e = (event ?? '').toLowerCase();
  if (e.includes('warning')) return 'warnings';
  if (e.includes('watch')) return 'watches';
  if (e.includes('advisory')) return 'advisories';
  if (e.includes('statement')) return 'statements';
  return 'other';
}

// F6: SQL/TS-parity classifier. Must match `public.nws_event_hazard` in
// supabase/migrations/20260601000002_subscriber_hazard_prefs.sql exactly —
// the SQL gate is authoritative at fan-out, this is what we use locally
// for previews and deliveryDecision().
export function nwsEventHazard(event: string | null | undefined): HazardKind | 'other' {
  const e = (event ?? '').toLowerCase();
  if (e.includes('tornado')) return 'tornado';
  if (e.includes('severe thunderstorm')) return 'severe';
  if (e.includes('flood')) return 'flood';
  if (e.includes('winter') || e.includes('ice') || e.includes('blizzard') || e.includes('freeze')) return 'winter';
  if (e.includes('heat')) return 'heat';
  if (e.includes('wind') || e.includes('gale')) return 'wind';
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
    // F6: hazard-level skip. Independent of category — a tornado WARNING can
    // be skipped if the subscriber opted out of all tornado alerts.
    const hazard = nwsEventHazard(input.nwsEvent);
    if (hazard !== 'other' && prefs.skip_hazards.includes(hazard)) return 'skip';
  }

  if (qh?.enabled && !isWarningClass(input.nwsEvent)) {
    if (input.messageSource === 'scheduled' || input.messageSource === 'nws') {
      if (inQuietHours(qh)) return 'defer';
    }
  }

  return 'send';
}

const HAZARD_LABEL: Record<HazardKind, string> = {
  tornado: 'tornado',
  severe: 'severe thunderstorm',
  flood: 'flood',
  winter: 'winter weather',
  heat: 'heat',
  wind: 'wind',
};

export function formatPrefsSummary(prefs: AlertPreferences, qh: QuietHours | null): string {
  const lines = [
    `Warnings: ${prefs.warnings ? 'ON' : 'off'}`,
    `Watches: ${prefs.watches ? 'ON' : 'off'}`,
    `Advisories: ${prefs.advisories ? 'ON' : 'off'}`,
    `Statements: ${prefs.statements ? 'ON' : 'off'}`,
  ];
  if (prefs.skip_hazards.length === 0) {
    lines.push('Hazards: all kinds');
  } else {
    const skipped = prefs.skip_hazards.map((h) => HAZARD_LABEL[h]).join(', ');
    lines.push(`Hazards: skipping ${skipped}`);
  }
  if (qh?.enabled) {
    lines.push(`Quiet hours: ${qh.start}–${qh.end} ${qh.timezone} (warnings still come through)`);
  } else {
    lines.push('Quiet hours: off');
  }
  lines.push(
    prefs.aggregate_warnings
      ? 'Outbreak grouping: ON (3+ simultaneous warnings arrive as one message)'
      : 'Outbreak grouping: off (each warning arrives separately)',
  );
  return lines.join('\n');
}
