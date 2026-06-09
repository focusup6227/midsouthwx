'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useBroadcastState, RISK_COLOR } from '../useBroadcastState';

// Corner "bug": channel mark, a live CT clock, the SPC Day-1 risk chip, and
// active warning/watch counts. Polls state for the live numbers.
//   ?brand=MID-SOUTH WX&accent=%23fbbf24&pos=top-right
function useClock(): string {
  const [now, setNow] = useState('');
  useEffect(() => {
    const tick = () =>
      setNow(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date()) + ' CT',
      );
    tick();
    const id = setInterval(tick, 1000 * 15);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Bug() {
  const q = useSearchParams();
  const live = q.get('live') === '1';
  const pos = q.get('pos') ?? 'top-right';
  const state = useBroadcastState(live ? 5000 : 30000);
  const clock = useClock();
  const ctl = live ? state?.control ?? null : null;
  const brand = ctl?.brand?.trim() || q.get('brand') || 'MID-SOUTH WX';
  const accent = ctl?.accent?.trim() || q.get('accent') || '#fbbf24';

  // In live mode the console can hide the bug entirely.
  if (live && ctl && !ctl.bug_visible) return null;

  const corner =
    pos === 'top-left' ? 'top-0 left-0 items-start'
    : pos === 'bottom-left' ? 'bottom-0 left-0 items-start'
    : pos === 'bottom-right' ? 'bottom-0 right-0 items-end'
    : 'top-0 right-0 items-end';

  const risk = state?.day1_label ?? null;
  const riskColor = risk ? RISK_COLOR[risk] ?? '#64748b' : null;

  return (
    <div className={`absolute flex flex-col gap-[1vh] p-[3vh] ${corner}`}>
      <div className="flex items-center gap-[1.4vh] rounded-md bg-black/80 px-[2vh] py-[1.2vh] backdrop-blur-sm shadow-xl">
        <span className="text-[2.4vh] font-extrabold uppercase tracking-widest" style={{ color: accent }}>
          {brand}
        </span>
        <span className="text-[2vh] font-mono font-semibold text-white/85">{clock}</span>
      </div>

      <div className="flex items-center gap-[1vh]">
        {risk ? (
          <span
            className="rounded px-[1.4vh] py-[0.7vh] text-[1.7vh] font-extrabold uppercase"
            style={{ background: riskColor!, color: '#0b1220' }}
          >
            Day 1 {risk}
          </span>
        ) : null}
        {state && state.warnings_count > 0 ? (
          <span className="rounded bg-red-600 px-[1.4vh] py-[0.7vh] text-[1.7vh] font-bold">
            {state.warnings_count} warning{state.warnings_count > 1 ? 's' : ''}
          </span>
        ) : null}
        {state && state.watches_count > 0 ? (
          <span className="rounded bg-amber-500 px-[1.4vh] py-[0.7vh] text-[1.7vh] font-bold text-black">
            {state.watches_count} watch{state.watches_count > 1 ? 'es' : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Bug />
    </Suspense>
  );
}
