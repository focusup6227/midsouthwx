'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SceneShell } from '../_shared';

// Sign-off / outro card. ?title=&sub=&brand=&accent=
function Outro() {
  const q = useSearchParams();
  const title = q.get('title') ?? 'Thanks for Watching';
  const sub = q.get('sub') ?? 'Stay weather-aware. Follow your local NWS for official warnings.';
  const brand = q.get('brand') ?? 'MID-SOUTH WX';
  const accent = q.get('accent') ?? '#fbbf24';
  return (
    <SceneShell brand={brand} accent={accent} showAlerts={false}>
      <div className="text-[8.5vh] font-extrabold leading-tight" style={{ textShadow: '0 6px 30px rgba(0,0,0,.5)' }}>
        {title}
      </div>
      <div className="mt-[3vh] max-w-[60vw] text-[2.8vh] font-medium text-white/60">{sub}</div>
      <div className="mt-[5vh] text-[2.2vh] font-bold uppercase tracking-[0.3em]" style={{ color: accent }}>
        Like · Subscribe · Share
      </div>
    </SceneShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Outro />
    </Suspense>
  );
}
