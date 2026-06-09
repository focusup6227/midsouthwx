'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { SceneShell, useCountdown } from '../_shared';

// "Starting soon" standby card with an optional countdown.
//   ?title=STARTING SOON&sub=Severe Weather Briefing
//   ?at=2026-06-09T23:00:00Z   (absolute target)  OR  ?in=10  (minutes from load)
//   ?brand=MID-SOUTH WX&accent=%23fbbf24
function Standby() {
  const q = useSearchParams();
  const title = q.get('title') ?? 'Starting Soon';
  const sub = q.get('sub') ?? 'Severe Weather Briefing';
  const brand = q.get('brand') ?? 'MID-SOUTH WX';
  const accent = q.get('accent') ?? '#fbbf24';

  // Resolve a countdown target once on mount: absolute ?at wins, else ?in mins.
  const targetMs = useMemo(() => {
    const at = q.get('at');
    if (at) {
      const t = Date.parse(at);
      if (!Number.isNaN(t)) return t;
    }
    const mins = Number(q.get('in'));
    if (mins > 0) return Date.now() + mins * 60_000;
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { label, done } = useCountdown(targetMs);

  return (
    <SceneShell brand={brand} accent={accent}>
      <div className="text-[2.4vh] font-semibold uppercase tracking-[0.5em] text-white/50">{sub}</div>
      <div className="mt-[2vh] text-[10vh] font-extrabold leading-none" style={{ textShadow: '0 6px 30px rgba(0,0,0,.5)' }}>
        {title}
      </div>
      {targetMs != null ? (
        <div className="mt-[4vh] flex items-center gap-[2vh]">
          <span
            className="rounded-2xl px-[4vh] py-[2vh] font-mono text-[9vh] font-bold tabular-nums"
            style={{ background: 'rgba(0,0,0,.4)', color: done ? accent : '#fff', border: `2px solid ${accent}55` }}
          >
            {done ? 'NOW' : label}
          </span>
        </div>
      ) : null}
      <div className="mt-[5vh] flex items-center gap-[1.4vh] text-[2vh] text-white/50">
        <span className="inline-block h-[1.4vh] w-[1.4vh] animate-pulse rounded-full" style={{ background: accent }} />
        Stand by — we&apos;ll be live shortly
      </div>
    </SceneShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Standby />
    </Suspense>
  );
}
