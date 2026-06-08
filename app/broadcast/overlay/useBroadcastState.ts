'use client';

import { useEffect, useState } from 'react';
import type { BroadcastState } from '@/lib/broadcast/data';

// Polls the public overlay state feed. Used by the ticker and corner bug so
// they stay current while live without a page reload. Refreshes on a timer
// and again whenever the tab/source regains focus.
export function useBroadcastState(pollMs = 30000): BroadcastState | null {
  const [state, setState] = useState<BroadcastState | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/broadcast/state', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as BroadcastState;
        if (alive) setState(j);
      } catch {
        /* keep last good state on a transient failure */
      }
    };
    load();
    const id = setInterval(load, pollMs);
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [pollMs]);

  return state;
}

// Risk-label → on-air color. Mirrors the SPC categorical palette used in the
// social cards so the brand reads consistently across graphics and overlays.
export const RISK_COLOR: Record<string, string> = {
  TSTM: '#4ade80',
  MRGL: '#22c55e',
  SLGT: '#eab308',
  ENH: '#f97316',
  MDT: '#ef4444',
  HIGH: '#d946ef',
};
