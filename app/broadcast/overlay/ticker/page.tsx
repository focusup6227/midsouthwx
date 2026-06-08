'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';
import { useBroadcastState } from '../useBroadcastState';

// Full-width scrolling crawl of active NWS warnings/watches across the bottom
// of frame. Polls /api/broadcast/state, so it stays live as alerts come and
// go. Tornado warnings get a red bias; watches amber.
//   ?label=ALERTS&accent=%23fbbf24&speed=40   (speed = seconds per loop)
function tone(event: string): string {
  const e = event.toLowerCase();
  if (e.includes('tornado') && e.includes('warning')) return '#ef4444';
  if (e.includes('warning')) return '#f97316';
  if (e.includes('watch')) return '#eab308';
  return '#38bdf8';
}

function Ticker() {
  const q = useSearchParams();
  const label = q.get('label') ?? 'ACTIVE ALERTS';
  const accent = q.get('accent') ?? '#fbbf24';
  const speed = Math.max(15, Math.min(180, Number(q.get('speed')) || 45));
  const state = useBroadcastState(30000);

  const segments = useMemo(() => {
    const items = state?.items ?? [];
    if (items.length === 0) {
      return [{ event: '', text: 'No active warnings or watches across the Mid-South at this time — conditions quiet.', color: '#94a3b8' }];
    }
    return items.map((it) => ({
      event: it.event,
      text: `${it.event}${it.area ? ` — ${it.area}` : ''}`,
      color: tone(it.event),
    }));
  }, [state]);

  // Duplicate the run so the marquee loops seamlessly.
  const run = [...segments, ...segments];

  return (
    <div className="absolute inset-x-0 bottom-0 flex h-[7vh] items-stretch bg-black/85 backdrop-blur-sm">
      <div
        className="flex shrink-0 items-center px-[2.5vh] text-[2.3vh] font-extrabold uppercase tracking-widest"
        style={{ background: accent, color: '#0b1220' }}
      >
        {label}
      </div>
      <div className="relative flex-1 overflow-hidden">
        <div
          className="absolute top-0 flex h-full items-center whitespace-nowrap will-change-transform"
          style={{ animation: `crawl ${speed}s linear infinite` }}
        >
          {run.map((s, i) => (
            <span key={i} className="flex items-center text-[2.4vh] font-semibold">
              <span className="mx-[2vh] inline-block h-[1.2vh] w-[1.2vh] rounded-full" style={{ background: s.color }} />
              <span>{s.text}</span>
              <span className="mx-[2vh] text-white/30">•</span>
            </span>
          ))}
        </div>
      </div>
      <style>{`@keyframes crawl{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Ticker />
    </Suspense>
  );
}
