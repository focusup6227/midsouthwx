// Subscriber-facing command help + reply keyboard labels.

import type { SendMessageInput } from './telegram.ts';

export const BTN_COMMANDS = '📋 Commands';
export const BTN_PREFS = '⚙️ Alerts';
export const BTN_STATUS = '🌩 Status';
export const BTN_LOCATION = '📍 Location';
export const BTN_HELP = '💬 Help';
export const BTN_SHARE_LIVE = '📡 Share live location';

export const SUBSCRIBER_BOT_COMMANDS = [
  { command: 'status', description: 'See your current settings' },
  { command: 'prefs', description: 'Alert types and quiet hours' },
  { command: 'where', description: 'Set a temporary location' },
  { command: 'home', description: 'Revert to your home address' },
  { command: 'help', description: 'Show menu and commands' },
  { command: 'unsubscribe', description: 'Stop receiving alerts' },
  { command: 'resume', description: 'Re-enable alerts after /unsubscribe' },
  { command: 'start', description: 'Finish sign-up with your link' },
] as const;

export function commandsHelpText(): string {
  return (
    'Mid-South WX — what you can do:\n\n' +
    'Use the buttons below the message box — no slash commands needed.\n\n' +
    '🌩 Status — see your current setup at a glance\n' +
    '📍 Location — set a temporary address or revert to home\n' +
    '⚙️ Alerts — toggle warnings/watches/advisories + quiet hours\n' +
    '💬 Help — this message\n' +
    '📡 Share live location — attach your current pin in Telegram\n\n' +
    'Power-user shortcuts (slash commands still work):\n' +
    '• /status, /prefs, /where <address>, /home\n' +
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
      [{ text: BTN_STATUS }, { text: BTN_LOCATION }],
      [{ text: BTN_PREFS }, { text: BTN_HELP }],
      [{ text: BTN_SHARE_LIVE, request_location: true }],
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
