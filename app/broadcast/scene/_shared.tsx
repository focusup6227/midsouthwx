'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useBroadcastState, RISK_COLOR } from '../overlay/useBroadcastState';

// Live CT wall clock, refreshed every 15s (seconds aren't shown).
export function useClock(): string {
  const [now, setNow] = useState('');
  useEffect(() => {
    const tick = () =>
      setNow(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago',
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date()) + ' CT',
      );
    tick();
    // Same visibility pattern as useBroadcastState: pause the tick while the
    // document is hidden and repaint immediately on return so the clock never
    // shows a stale minute. OBS browser sources always report visible, so
    // this is a no-op on air.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, 15000);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return now;
}

// mm:ss countdown to an absolute target time, ticking each second.
export function useCountdown(targetMs: number | null): { label: string; done: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (targetMs == null) return { label: '', done: false };
  const remain = Math.max(0, targetMs - now);
  const total = Math.floor(remain / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return { label: `${m}:${String(s).padStart(2, '0')}`, done: remain <= 0 };
}

// Shared full-frame chrome: animated brand background, a top bar with the brand
// mark + live clock + Day-1 SPC risk chip + warning/watch counts, the supplied
// centerpiece, and a bottom scrolling alert strip. Used by every scene.
export function SceneShell({
  brand,
  accent,
  children,
  showAlerts = true,
}: {
  brand: string;
  accent: string;
  children: ReactNode;
  showAlerts?: boolean;
}) {
  const state = useBroadcastState(30000);
  const clock = useClock();
  const risk = state?.day1_label ?? null;
  const riskColor = risk ? RISK_COLOR[risk] ?? '#64748b' : null;

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* Soft animated radial glow in the brand accent */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(60vw 60vw at 50% 38%, ${accent}22 0%, rgba(11,18,32,0) 60%)`,
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)',
          backgroundSize: '7vh 7vh',
        }}
      />

      {/* Top bar */}
      <div className="relative z-10 flex items-center justify-between px-[5vw] py-[3vh]">
        <div className="text-[2.6vh] font-extrabold uppercase tracking-[0.3em]" style={{ color: accent }}>
          {brand}
        </div>
        <div className="flex items-center gap-[1.4vh]">
          {risk ? (
            <span
              className="rounded px-[1.4vh] py-[0.7vh] text-[1.8vh] font-extrabold uppercase"
              style={{ background: riskColor!, color: '#0b1220' }}
            >
              Day 1 {risk}
            </span>
          ) : null}
          {state && state.warnings_count > 0 ? (
            <span className="rounded bg-red-600 px-[1.4vh] py-[0.7vh] text-[1.8vh] font-bold">
              {state.warnings_count} warn
            </span>
          ) : null}
          {state && state.watches_count > 0 ? (
            <span className="rounded bg-amber-500 px-[1.4vh] py-[0.7vh] text-[1.8vh] font-bold text-black">
              {state.watches_count} watch
            </span>
          ) : null}
          <span className="text-[2.1vh] font-mono font-semibold text-white/80">{clock}</span>
        </div>
      </div>

      {/* Centerpiece */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-[6vw] text-center">
        {children}
      </div>

      {/* Bottom alert strip */}
      {showAlerts ? <AlertStrip /> : <div className="h-[6vh]" />}
    </div>
  );
}

function AlertStrip() {
  const state = useBroadcastState(30000);
  const items = state?.items ?? [];
  const text =
    items.length === 0
      ? 'No active warnings or watches across the Mid-South — conditions quiet.'
      : items.map((i) => `${i.event}${i.area ? ` — ${i.area}` : ''}`).join('    •    ');
  const run = `${text}    •    ${text}`;
  return (
    <div className="relative z-10 flex h-[6vh] items-center overflow-hidden border-t border-white/10 bg-black/40">
      <div
        className="whitespace-nowrap text-[2vh] font-semibold text-white/85"
        style={{ animation: 'sceneCrawl 50s linear infinite' }}
      >
        {run}
      </div>
      <style>{`@keyframes sceneCrawl{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}
