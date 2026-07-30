'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';

// 1.5s trailing debounce so a burst of replies during an active event coalesces
// into a single SSR re-render instead of one per inbound message.
const REFRESH_DEBOUNCE_MS = 1500;

export default function InboxRefresher() {
  const router = useRouter();

  useEffect(() => {
    const supa = supabaseBrowser();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };

    const channel = supa
      .channel('inbox-replies')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'replies' },
        (payload) => {
          // Distress replies skip the debounce — during an active event the
          // operator needs the red badge the moment it lands.
          const row = payload.new as { is_distress?: boolean } | null;
          if (row?.is_distress) {
            if (timer) clearTimeout(timer);
            timer = null;
            router.refresh();
          } else {
            scheduleRefresh();
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations' },
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
