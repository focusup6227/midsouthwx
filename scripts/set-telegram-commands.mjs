#!/usr/bin/env node
/**
 * Register subscriber bot commands + menu button with Telegram.
 * Reads TELEGRAM_BOT_TOKEN from .env.local
 *
 * Usage: node scripts/set-telegram-commands.mjs
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(root, '.env.local'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* optional */
  }
}

loadEnvLocal();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env.local');
  process.exit(1);
}

// Keep in sync with SUBSCRIBER_BOT_COMMANDS in
// supabase/functions/telegram-webhook/bot-commands.ts.
const commands = [
  { command: 'status', description: 'See your current settings' },
  { command: 'prefs', description: 'Alert types and quiet hours' },
  { command: 'where', description: 'Set a temporary location' },
  { command: 'home', description: 'Revert to your home address' },
  { command: 'help', description: 'Show menu and commands' },
  { command: 'unsubscribe', description: 'Stop receiving alerts' },
  { command: 'resume', description: 'Re-enable alerts after /unsubscribe' },
  { command: 'start', description: 'Finish sign-up with your link' },
];

const base = `https://api.telegram.org/bot${token}`;

const r1 = await fetch(`${base}/setMyCommands`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ commands }),
});
const j1 = await r1.json();
if (!j1.ok) {
  console.error('setMyCommands failed', j1);
  process.exit(1);
}

const r2 = await fetch(`${base}/setChatMenuButton`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ menu_button: { type: 'commands' } }),
});
const j2 = await r2.json();
if (!j2.ok) {
  console.error('setChatMenuButton failed', j2);
  process.exit(1);
}

console.log('OK — bot commands and menu button registered.');
