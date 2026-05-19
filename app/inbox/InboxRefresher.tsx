'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';

export default function InboxRefresher() {
  const router = useRouter();

  useEffect(() => {
    const supa = supabaseBrowser();
    const channel = supa
      .channel('inbox-replies')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'replies' },
        () => router.refresh(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations' },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      supa.removeChannel(channel);
    };
  }, [router]);

  return null;
}
