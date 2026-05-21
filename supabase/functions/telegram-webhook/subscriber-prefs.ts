// Mirror of lib/subscribers/prefs.ts for Deno Edge bundle.

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
  const lines = [
    'Your alert preferences:',
    `• Warnings: ${prefs.warnings ? 'ON' : 'off'}`,
    `• Watches: ${prefs.watches ? 'ON' : 'off'}`,
    `• Advisories: ${prefs.advisories ? 'ON' : 'off'}`,
    `• Statements: ${prefs.statements ? 'ON' : 'off'}`,
    qh.enabled
      ? `• Quiet hours: ${qh.start}–${qh.end} (${qh.timezone}) — warnings still come through`
      : '• Quiet hours: off',
    '',
    'Tap a button to toggle. Manual operator alerts always come through.',
  ];
  return lines.join('\n');
}

export function prefsKeyboard(prefs: AlertPreferences, qh: QuietHours) {
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
      [
        {
          text: qh.enabled ? '🔕 Quiet hours ON' : '🔔 Quiet hours off',
          callback_data: 'pref:toggle:quiet',
        },
      ],
    ],
  };
}
