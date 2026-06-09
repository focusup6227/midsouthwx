'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useBroadcastState } from '../useBroadcastState';

// Breaking-alert takeover. A transparent OBS layer that renders NOTHING until a
// qualifying warning is active, then paints a full-frame red takeover. Drop it
// as a top layer in OBS and it auto-shows the moment a tornado warning hits.
// Polls fast (15s) so it appears promptly.
//   ?events=tornado            (comma-separated keywords; default tornado)
//   ?match=warning,emergency   (event must also contain one of these; default both)
function Breaking() {
  const q = useSearchParams();
  const state = useBroadcastState(15000);

  const keywords = (q.get('events') ?? 'tornado').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const matchers = (q.get('match') ?? 'warning,emergency').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

  const hits = useMemo(() => {
    const items = state?.items ?? [];
    return items.filter((it) => {
      const e = it.event.toLowerCase();
      return keywords.some((k) => e.includes(k)) && matchers.some((m) => e.includes(m));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (hits.length === 0) return null;

  // A tornado emergency outranks a warning for the banner label.
  const emergency = hits.find((h) => h.event.toLowerCase().includes('emergency'));
  const headline = (emergency ?? hits[0]).event.toUpperCase();
  const areas = Array.from(new Set(hits.map((h) => h.area).filter(Boolean))) as string[];

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-700/92 text-white" style={{ animation: 'breakIn 350ms ease-out' }}>
      <div className="absolute inset-0" style={{ animation: 'breakPulse 1.6s ease-in-out infinite', background: 'radial-gradient(80vw 80vw at 50% 50%, rgba(255,255,255,.12), rgba(0,0,0,0) 60%)' }} />
      <div className="relative z-10 flex items-center gap-[2vh] text-[3vh] font-extrabold uppercase tracking-[0.4em]">
        <span style={{ animation: 'breakPulse 1s ease-in-out infinite' }}>⚠</span> Breaking
      </div>
      <div className="relative z-10 mt-[1.5vh] text-[9vh] font-extrabold leading-none" style={{ textShadow: '0 4px 24px rgba(0,0,0,.5)' }}>
        {headline}
      </div>
      {areas.length > 0 ? (
        <div className="relative z-10 mt-[2.5vh] max-w-[80vw] text-center text-[3vh] font-semibold text-white/90">
          {areas.slice(0, 4).join(' · ')}
          {areas.length > 4 ? ` +${areas.length - 4} more` : ''}
        </div>
      ) : null}
      <div className="relative z-10 mt-[4vh] rounded-xl bg-black/30 px-[4vh] py-[1.6vh] text-[4vh] font-extrabold tracking-widest">
        TAKE COVER NOW
      </div>
      <div className="relative z-10 mt-[2.5vh] text-[2vh] font-medium text-white/80">
        Go to the lowest floor, an interior room, away from windows. Follow your local NWS.
      </div>
      <style>{`@keyframes breakIn{from{opacity:0}to{opacity:1}}@keyframes breakPulse{0%,100%{opacity:.55}50%{opacity:1}}`}</style>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Breaking />
    </Suspense>
  );
}
