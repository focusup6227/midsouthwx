'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { markRead } from './actions';

export default function ThreadAutoRead({ conversationId }: { conversationId: string }) {
  const router = useRouter();

  useEffect(() => {
    markRead(conversationId).catch(() => {});
  }, [conversationId]);

  useEffect(() => {
    const supa = supabaseBrowser();
    const channel = supa
      .channel(`thread-${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'replies',
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          router.refresh();
          markRead(conversationId).catch(() => {});
        },
      )
      .subscribe();

    return () => {
      supa.removeChannel(channel);
    };
  }, [conversationId, router]);

  return null;
}
