'use client';

import type { BroadcastScript } from '@/lib/ai/broadcast-script';

// The generated script lives in localStorage so the console and the
// teleprompter (a separate route, often opened in its own window/monitor) share
// it without a round-trip or a DB table. Single-operator app — this is the
// pragmatic store. Bumped meta lets the teleprompter show staleness.
const KEY = 'midsouthwx:broadcast-script';

export type StoredScript = {
  script: BroadcastScript;
  savedAt: string;
  generatedFor?: string; // briefing snapshot time
};

export function saveScript(script: BroadcastScript, generatedFor?: string): void {
  try {
    const payload: StoredScript = { script, savedAt: new Date().toISOString(), generatedFor };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}

export function loadScript(): StoredScript | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredScript;
  } catch {
    return null;
  }
}

export function clearScript(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}

// Flatten segments into the continuous body a presenter reads top to bottom.
export function scriptToPrompterText(s: BroadcastScript): string {
  return s.segments.map((seg) => `【 ${seg.name} 】\n\n${seg.script}`).join('\n\n\n');
}
