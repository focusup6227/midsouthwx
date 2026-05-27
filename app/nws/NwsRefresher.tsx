'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';

// Live-refreshes the /nws page when:
//   - a new NWS alert is ingested (nws_alerts INSERT/UPDATE)
//   - an NWS message is approved/rejected (messages UPDATE where source='nws')
//   - a new NWS message lands in pending_approval (messages INSERT where source='nws')
//
// Refreshes are debounced (1.5s trailing edge) so a burst of alert ingest
// during a tornado outbreak doesn't fire dozens of full SSR re-renders per
// minute. The trailing edge guarantees the operator still sees the *last*
// state from each burst.
const REFRESH_DEBOUNCE_MS = 1500;

export default function NwsRefresher() {
  const router = useRouter();

  useEffect(() => {
    const supa = supabaseBrowser();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };

    const channel = supa
      .channel('nws-page')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'nws_alerts' },
        scheduleRefresh,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: 'source=eq.nws' },
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
