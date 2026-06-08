'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

// Branded lower-third name/title plate. All text comes from query params set
// by the operator in the broadcast console, so nothing is read from the DB —
// safe to serve to a cookieless OBS browser source.
//   ?title=Tyler Dixon&subtitle=Mid-South WX&brand=MID-SOUTH WX&accent=%23fbbf24&pos=left
function LowerThird() {
  const q = useSearchParams();
  const title = q.get('title') ?? 'Mid-South WX';
  const subtitle = q.get('subtitle') ?? 'Severe Weather Briefing';
  const brand = q.get('brand') ?? 'MID-SOUTH WX';
  const accent = q.get('accent') ?? '#fbbf24';
  const pos = q.get('pos') === 'right' ? 'items-end' : 'items-start';

  return (
    <div className={`flex h-full w-full flex-col justify-end ${pos} p-[4vh]`}>
      <div className="flex overflow-hidden rounded-md shadow-2xl animate-[ltslide_500ms_ease-out]">
        <div style={{ background: accent }} className="w-[1.2vh] shrink-0" />
        <div className="bg-black/80 backdrop-blur-sm px-[2.6vh] py-[1.6vh]">
          <div
            className="text-[1.4vh] font-bold uppercase tracking-[0.35em]"
            style={{ color: accent }}
          >
            {brand}
          </div>
          <div className="mt-[0.4vh] text-[3.4vh] font-extrabold leading-tight">{title}</div>
          <div className="text-[1.9vh] font-medium text-white/70">{subtitle}</div>
        </div>
      </div>
      <style>{`@keyframes ltslide{from{opacity:0;transform:translateX(-3vh)}to{opacity:1;transform:translateX(0)}}`}</style>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LowerThird />
    </Suspense>
  );
}
