import { supabaseServer } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import ThreadAutoRead from './ThreadAutoRead';
import ThreadReplyForm from './ThreadReplyForm';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

export default async function ThreadPage({ params }: { params: { conversation_id: string } }) {
  const supa = supabaseServer();

  const { data: convo } = await supa
    .from('conversations')
    .select('id, subscriber_id, unread_count, last_message_at, subscribers(id, display_name, telegram_chat_id, telegram_username, status, home_address, current_address, current_address_updated_at, phone)')
    .eq('id', params.conversation_id)
    .single();

  if (!convo) notFound();

  const sub = Array.isArray(convo.subscribers) ? convo.subscribers[0] : convo.subscribers;

  const { data: replies } = await supa
    .from('replies')
    .select('id, body, callback_data, is_distress, received_at, read_at, parent_message_id, direction, operator_user_id')
    .eq('conversation_id', params.conversation_id)
    .order('received_at', { ascending: true })
    .limit(500);

  // Pull the parent messages referenced by any threaded replies so we can
  // render a "↪ Replying to: …" caption. One round-trip with .in().
  const parentIds = Array.from(
    new Set(
      (replies ?? [])
        .map((r) => r.parent_message_id)
        .filter((id): id is string => !!id),
    ),
  );
  const parentMap = new Map<string, { id: string; body: string | null; created_at: string | null }>();
  if (parentIds.length > 0) {
    const { data: parents } = await supa
      .from('messages')
      .select('id, body, created_at')
      .in('id', parentIds);
    for (const p of parents ?? []) parentMap.set(p.id, p);
  }

  const hasDistress = (replies ?? []).some((r) => r.is_distress);
  const whereAt = sub?.current_address || sub?.home_address;
  const whereLabel = sub?.current_address ? 'Currently at' : 'Home';

  return (
    <DashShell title={sub?.display_name ?? 'Conversation'} backHref="/inbox" width="narrow">
      <ThreadAutoRead conversationId={params.conversation_id} />
      <p className="text-xs text-wx-mute">
        {sub?.telegram_username ? `@${sub.telegram_username} · ` : ''}
        chat id {sub?.telegram_chat_id ?? '—'} · status {sub?.status ?? '—'}
        {sub?.phone ? ` · ${sub.phone}` : ''}
      </p>

      {whereAt && (
        <section className={`card p-4 ${hasDistress ? 'border-wx-danger' : ''}`}>
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <div className={`text-xs uppercase tracking-wide ${hasDistress ? 'text-wx-danger' : 'text-wx-mute'}`}>
                📍 {whereLabel}{hasDistress ? ' — DISTRESS FLAGGED' : ''}
              </div>
              <div className="text-sm whitespace-pre-wrap mt-1">{whereAt}</div>
            </div>
            {sub?.current_address_updated_at && (
              <div className="text-xs text-wx-mute whitespace-nowrap">
                {new Date(sub.current_address_updated_at).toLocaleString()}
              </div>
            )}
          </div>
          {sub?.current_address && sub.home_address && (
            <p className="text-xs text-wx-mute mt-2">
              Home: {sub.home_address}
            </p>
          )}
        </section>
      )}

      <section className="card p-3 space-y-3 min-h-[12rem]">
        {replies?.length ? (
          replies.map((r) => {
            const outbound = r.direction === 'outbound';
            return (
              <div
                key={r.id}
                className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 space-y-1 ${
                    outbound
                      ? 'bg-wx-accent/15 border border-wx-accent/30'
                      : 'bg-wx-ink/50 border border-wx-line'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs text-wx-mute flex-wrap">
                    <span>{outbound ? 'You' : sub?.display_name ?? 'Subscriber'}</span>
                    <span>{new Date(r.received_at).toLocaleString()}</span>
                    {r.is_distress && (
                      <span className="px-1.5 py-0.5 rounded bg-wx-danger/20 text-wx-danger">
                        distress
                      </span>
                    )}
                    {r.callback_data && (
                      <span className="px-1.5 py-0.5 rounded bg-wx-accent/20 text-wx-accent">
                        tap: {r.callback_data}
                      </span>
                    )}
                  </div>
                  {r.parent_message_id && parentMap.has(r.parent_message_id) && (
                    <div className="border-l-2 border-wx-line/60 pl-2 -my-0.5 text-[11px] text-wx-mute">
                      <span className="opacity-70">↪ Replying to: </span>
                      <span className="italic line-clamp-2">
                        {(parentMap.get(r.parent_message_id)!.body ?? '').slice(0, 200) || '(no body)'}
                      </span>
                    </div>
                  )}
                  {r.body && (
                    <p className="text-sm whitespace-pre-wrap">{r.body}</p>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-wx-mute text-sm p-2">No messages yet.</p>
        )}
      </section>

      {sub && (
        <ThreadReplyForm
          conversationId={params.conversation_id}
          subscriberId={sub.id}
          telegramLinked={Boolean(sub.telegram_chat_id)}
          subscriberStatus={sub.status ?? 'pending'}
        />
      )}
    </DashShell>
  );
}
