'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';

// F5: dashboard-wide check-in realtime. Subscribes to the whole
// check_in_responses table (no per-message filter like CheckinTally does on
// /alerts/[id]) so any subscriber tap, on any recent check-in, re-fetches
// the rollups via router.refresh(). Volume is low — at most a few hundred
// rows per active event — so a broad subscription is fine. Refresh is
// debounced 1.5s so concurrent taps don't thrash the rollup queries.
const REFRESH_DEBOUNCE_MS = 1500;

export default function CheckinsRealtime() {
  const router = useRouter();

  useEffect(() => {
    const supa = supabaseBrowser();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };

    const channel = supa
      .channel('checkins-dashboard')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'check_in_responses' },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supa.removeChannel(channel);
    };
  }, [router]);

  return null;
}
