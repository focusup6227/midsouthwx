'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';

// Live-refreshes the /nws page when:
//   - a new NWS alert is ingested (nws_alerts INSERT/UPDATE)
//   - an NWS message is approved/rejected (messages UPDATE where source='nws')
//   - a new NWS message lands in pending_approval (messages INSERT where source='nws')
export default function NwsRefresher() {
  const router = useRouter();

  useEffect(() => {
    const supa = supabaseBrowser();
    const channel = supa
      .channel('nws-page')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'nws_alerts' },
        () => router.refresh(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: 'source=eq.nws' },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      supa.removeChannel(channel);
    };
  }, [router]);

  return null;
}
