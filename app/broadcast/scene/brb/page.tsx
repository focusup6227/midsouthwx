'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SceneShell } from '../_shared';

// "Be right back" intermission. ?title=&sub=&brand=&accent=
function Brb() {
  const q = useSearchParams();
  const title = q.get('title') ?? 'Be Right Back';
  const sub = q.get('sub') ?? 'Stay tuned';
  const brand = q.get('brand') ?? 'MID-SOUTH WX';
  const accent = q.get('accent') ?? '#fbbf24';
  return (
    <SceneShell brand={brand} accent={accent}>
      <div className="text-[10vh] font-extrabold leading-none" style={{ textShadow: '0 6px 30px rgba(0,0,0,.5)' }}>
        {title}
      </div>
      <div className="mt-[3vh] text-[3vh] font-semibold text-white/60">{sub}</div>
    </SceneShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Brb />
    </Suspense>
  );
}
