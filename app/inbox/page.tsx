import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import InboxRefresher from './InboxRefresher';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const supa = supabaseServer();

  const { data: convos } = await supa
    .from('conversations')
    .select('id, subscriber_id, last_message_at, unread_count, pinned, subscribers(display_name, telegram_chat_id)')
    .order('pinned', { ascending: false })
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100);

  const convIds = (convos ?? []).map((c) => c.id);
  const { data: recent } =
    convIds.length > 0
      ? await supa
          .from('replies')
          .select('id, conversation_id, body, callback_data, is_distress, received_at, read_at')
          .in('conversation_id', convIds)
          .order('received_at', { ascending: false })
          .limit(convIds.length * 5)
      : { data: [] as {
          id: string;
          conversation_id: string;
          body: string | null;
          callback_data: string | null;
          is_distress: boolean | null;
          received_at: string;
          read_at: string | null;
        }[] };

  const latestByConv = new Map<string, NonNullable<typeof recent>[number]>();
  for (const r of recent ?? []) {
    if (!latestByConv.has(r.conversation_id)) latestByConv.set(r.conversation_id, r);
  }

  return (
    <DashShell title="Inbox" width="narrow">
      <InboxRefresher />
      <section className="card divide-y divide-wx-line">
        {convos?.length ? (
          convos.map((c) => {
            const latest = latestByConv.get(c.id);
            const sub = Array.isArray(c.subscribers) ? c.subscribers[0] : c.subscribers;
            const preview = latest?.body ?? (latest?.callback_data ? `[tap: ${latest.callback_data}]` : '');
            return (
              <Link
                key={c.id}
                href={`/inbox/${c.id}`}
                className="flex items-center justify-between gap-4 p-4 hover:bg-wx-ink/40 transition"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">
                      {sub?.display_name ?? 'Unknown subscriber'}
                    </span>
                    {latest?.is_distress && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-wx-danger/20 text-wx-danger">
                        distress
                      </span>
                    )}
                    {c.unread_count > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-wx-accent/20 text-wx-accent">
                        {c.unread_count}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-wx-mute truncate mt-0.5">{preview || '—'}</div>
                </div>
                <div className="text-xs text-wx-mute whitespace-nowrap">
                  {c.last_message_at
                    ? new Date(c.last_message_at).toLocaleString()
                    : ''}
                </div>
              </Link>
            );
          })
        ) : (
          <p className="text-wx-mute text-sm p-5">No conversations yet.</p>
        )}
      </section>
    </DashShell>
  );
}
