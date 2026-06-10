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
    // Same visibility pattern as useBroadcastState: pause the tick while the
    // document is hidden and repaint immediately on return so the clock never
    // shows a stale minute. OBS browser sources always report visible, so
    // this is a no-op on air.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, 1000 * 15);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return now;
}

function Bug() {
  const q = useSearchParams();
  const brand = q.get('brand') ?? 'MID-SOUTH WX';
  const accent = q.get('accent') ?? '#fbbf24';
  const pos = q.get('pos') ?? 'top-right';
  const state = useBroadcastState(30000);
  const clock = useClock();

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
