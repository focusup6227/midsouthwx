'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';

export default function CheckinTally({
  messageId,
  initial,
  recipientCount,
}: {
  messageId: string;
  initial: Record<string, number>;
  recipientCount: number;
}) {
  const router = useRouter();

  useEffect(() => {
    const supa = supabaseBrowser();
    const channel = supa
      .channel(`checkin-${messageId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'check_in_responses',
          filter: `message_id=eq.${messageId}`,
        },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      supa.removeChannel(channel);
    };
  }, [messageId, router]);

  const entries = Object.entries(initial);
  const totalResponded = entries.reduce((s, [, n]) => s + n, 0);
  const awaiting = Math.max(recipientCount - totalResponded, 0);

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold">Check-in tally</h2>
      <div className="flex flex-wrap gap-4 text-sm">
        {entries.length === 0 ? (
          <span className="text-wx-mute">No responses yet.</span>
        ) : (
          entries.map(([code, n]) => (
            <span key={code}>
              {code}: <strong>{n}</strong>
            </span>
          ))
        )}
        <span className={awaiting > 0 ? 'text-wx-mute' : 'text-wx-ok'}>
          awaiting: <strong>{awaiting}</strong>
        </span>
      </div>
      <p className="text-xs text-wx-mute">
        Updates live as subscribers tap.
      </p>
    </section>
  );
}
