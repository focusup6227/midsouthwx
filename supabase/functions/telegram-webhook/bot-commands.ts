// Subscriber-facing command help + reply keyboard labels.

import type { SendMessageInput } from './telegram.ts';

export const BTN_COMMANDS = '📋 Commands';
export const BTN_PREFS = '⚙️ Alerts';
export const BTN_STATUS = '🌩 Status';
export const BTN_LOCATION = '📍 Location';
export const BTN_HELP = '💬 Help';
export const BTN_REPORT = '📣 Report';
export const BTN_SHARE_LIVE = '📡 Share live location';

export const SUBSCRIBER_BOT_COMMANDS = [
  { command: 'status', description: 'See your current settings' },
  { command: 'prefs', description: 'Alert types and quiet hours' },
  { command: 'where', description: 'Set a temporary location' },
  { command: 'home', description: 'Revert to your home address' },
  { command: 'report', description: 'Report severe weather with a photo' },
  { command: 'help', description: 'Show menu and commands' },
  { command: 'unsubscribe', description: 'Stop receiving alerts' },
  { command: 'resume', description: 'Re-enable alerts after /unsubscribe' },
  { command: 'start', description: 'Finish sign-up with your link' },
] as const;

/** Hazard picker shown after /report. Keep labels emoji-prefixed so the
 *  subscriber can tap fast even on a small screen. Callback data is read by
 *  the webhook's `report:<hazard>` handler. */
export function reportHazardKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🌪 Tornado', callback_data: 'report:tornado' },
        { text: '🌀 Funnel cloud', callback_data: 'report:funnel' },
      ],
      [
        { text: '💨 Damaging wind', callback_data: 'report:wind' },
        { text: '🧊 Hail', callback_data: 'report:hail' },
      ],
      [
        { text: '🌊 Flooding', callback_data: 'report:flood' },
        { text: '⚠️ Other', callback_data: 'report:other' },
      ],
      [
        { text: '✖️ Cancel', callback_data: 'report:cancel' },
      ],
    ],
  };
}

const HAZARD_LABELS: Record<string, string> = {
  tornado: 'Tornado',
  funnel: 'Funnel cloud',
  wind: 'Damaging wind',
  hail: 'Hail',
  flood: 'Flooding',
  other: 'Severe weather',
};
export function hazardLabel(h: string): string {
  return HAZARD_LABELS[h] ?? 'Severe weather';
}

export function commandsHelpText(): string {
  return (
    'Mid-South WX — what you can do:\n\n' +
    'Use the buttons below the message box — no slash commands needed.\n\n' +
    '📣 Report — send a storm report (photo, description, or both)\n' +
    '🌩 Status — see your current setup at a glance\n' +
    '📍 Location — set a temporary address or revert to home\n' +
    '⚙️ Alerts — toggle warnings/watches/advisories + quiet hours\n' +
    '💬 Help — this message\n' +
    '📡 Share live location — attach your current pin in Telegram\n\n' +
    'Power-user shortcuts (slash commands still work):\n' +
    '• /status, /prefs, /where <address>, /home, /report\n' +
    '• /unsubscribe or STOP — opt out\n' +
    '• /start <link> — finish sign-up from the website link\n\n' +
    'Reply to any alert in Telegram to message the operator. They will see ' +
    'which alert you replied to.'
  );
}

/** Persistent buttons above the message field (subscriber chats). The five
 *  primary actions are tap-only — no slash commands required. Power users can
 *  still type /help, /prefs, /where, /home, /status, /resume, /unsubscribe. */
export function subscriberReplyKeyboard(): NonNullable<SendMessageInput['reply_markup']> {
  return {
    keyboard: [
      [{ text: BTN_REPORT }, { text: BTN_SHARE_LIVE, request_location: true }],
      [{ text: BTN_STATUS }, { text: BTN_LOCATION }],
      [{ text: BTN_PREFS }, { text: BTN_HELP }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function isStatusMenuText(text: string | undefined): boolean {
  return text?.trim() === BTN_STATUS || text?.trim() === '/status';
}
export function isLocationMenuText(text: string | undefined): boolean {
  return text?.trim() === BTN_LOCATION;
}
export function isHelpMenuText(text: string | undefined): boolean {
  return text?.trim() === BTN_HELP;
}
export function isReportMenuText(text: string | undefined): boolean {
  return text?.trim() === BTN_REPORT;
}

/** Inline keyboard shown when the user taps the Location menu button. Each
 *  entry maps to a `loc:*` callback handled by the webhook. */
export function locationInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✏️ Update temporary address', callback_data: 'loc:set' }],
      [{ text: '🏠 Back to home address', callback_data: 'loc:home' }],
    ],
  };
}

/** Quick actions under the help message. */
export function helpInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '⚙️ Open preferences', callback_data: 'cmd:prefs' }],
      [
        { text: 'Where (/where)', callback_data: 'cmd:where_help' },
        { text: 'Home (/home)', callback_data: 'cmd:home' },
      ],
    ],
  };
}

export function isCommandsMenuText(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return t === '/help' || t.startsWith('/help@') || t === BTN_COMMANDS;
}

export function isPrefsMenuText(text: string | undefined): boolean {
  return text?.trim() === BTN_PREFS;
}

const CMD_CALLBACK = /^cmd:(help|prefs|where_help|home)$/;

export function parseCmdCallback(data: string): string | null {
  const m = CMD_CALLBACK.exec(data);
  return m ? m[1] : null;
}
