// Mirror of lib/subscribers/prefs.ts for Deno Edge bundle.

// F6: keep in sync with lib/subscribers/prefs.ts AND nws_event_hazard() SQL
// in 20260601000002_subscriber_hazard_prefs.sql. Adding a hazard kind means
// touching all three.
export const HAZARD_KINDS = ['tornado', 'severe', 'flood', 'winter', 'heat', 'wind'] as const;
export type HazardKind = typeof HAZARD_KINDS[number];

export const HAZARD_BUTTON: Record<HazardKind, string> = {
  tornado: '🌪️ Tornado',
  severe: '⛈️ Severe',
  flood: '🌊 Flood',
  winter: '❄️ Winter',
  heat: '🔥 Heat',
  wind: '💨 Wind',
};

export type AlertPreferences = {
  warnings: boolean;
  watches: boolean;
  advisories: boolean;
  statements: boolean;
  skip_hazards: HazardKind[];
  // F-aggregation: when false, the send worker skips outbreak aggregation
  // for this subscriber and sends each warning as its own message. Default
  // true (aggregate) — matches the worker's existing read of the field.
  aggregate_warnings: boolean;
};

function isHazardKind(x: unknown): x is HazardKind {
  return typeof x === 'string' && (HAZARD_KINDS as readonly string[]).includes(x);
}

export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
};

// Mirror of lib/subscribers/prefs.ts. Conservative — warnings only — so new
// subscribers aren't overwhelmed before they tune their prefs.
export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = {
  warnings: true,
  watches: false,
  advisories: false,
  statements: false,
  skip_hazards: [],
  aggregate_warnings: true,
};

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

export function parseQuietHours(raw: unknown): QuietHours {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_QUIET_HOURS };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    start: typeof o.start === 'string' ? o.start : DEFAULT_QUIET_HOURS.start,
    end: typeof o.end === 'string' ? o.end : DEFAULT_QUIET_HOURS.end,
    timezone: typeof o.timezone === 'string' ? o.timezone : DEFAULT_QUIET_HOURS.timezone,
  };
}

export function formatPrefsSummary(prefs: AlertPreferences, qh: QuietHours): string {
  const skipped = prefs.skip_hazards.length
    ? `• Skipping hazards: ${prefs.skip_hazards.map((h) => HAZARD_BUTTON[h].split(' ')[1]).join(', ')}`
    : '• Hazards: all kinds';
  const lines = [
    'Your alert preferences:',
    `• Warnings: ${prefs.warnings ? 'ON' : 'off'}`,
    `• Watches: ${prefs.watches ? 'ON' : 'off'}`,
    `• Advisories: ${prefs.advisories ? 'ON' : 'off'}`,
    `• Statements: ${prefs.statements ? 'ON' : 'off'}`,
    skipped,
    qh.enabled
      ? `• Quiet hours: ${qh.start}–${qh.end} (${qh.timezone}) — warnings still come through`
      : '• Quiet hours: off',
    prefs.aggregate_warnings
      ? '• Outbreak grouping: ON — multiple simultaneous warnings arrive as one message'
      : '• Outbreak grouping: off — each warning arrives separately',
    '',
    'Tap a button to toggle. Hazard buttons mute that kind across all alerts.',
    'Manual operator alerts always come through.',
  ];
  return lines.join('\n');
}

export function prefsKeyboard(prefs: AlertPreferences, qh: QuietHours) {
  // F6: hazard rows — a checkmark means "currently receiving" (NOT in
  // skip_hazards). Tapping toggles membership in the array.
  const skipSet = new Set<string>(prefs.skip_hazards);
  const hazardButton = (kind: HazardKind) => ({
    text: `${skipSet.has(kind) ? '○' : '✓'} ${HAZARD_BUTTON[kind]}`,
    callback_data: `pref:hazard:${kind}`,
  });
  return {
    inline_keyboard: [
      [
        { text: `${prefs.warnings ? '✓' : '○'} Warnings`, callback_data: 'pref:toggle:warnings' },
        { text: `${prefs.watches ? '✓' : '○'} Watches`, callback_data: 'pref:toggle:watches' },
      ],
      [
        { text: `${prefs.advisories ? '✓' : '○'} Advisories`, callback_data: 'pref:toggle:advisories' },
        { text: `${prefs.statements ? '✓' : '○'} Statements`, callback_data: 'pref:toggle:statements' },
      ],
      [hazardButton('tornado'), hazardButton('severe')],
      [hazardButton('flood'), hazardButton('winter')],
      [hazardButton('heat'), hazardButton('wind')],
      [
        {
          text: qh.enabled ? '🔕 Quiet hours ON' : '🔔 Quiet hours off',
          callback_data: 'pref:toggle:quiet',
        },
        {
          text: prefs.aggregate_warnings
            ? '📦 Group outbreak: ON'
            : '📨 Group outbreak: off',
          callback_data: 'pref:toggle:aggregate',
        },
      ],
    ],
  };
}
