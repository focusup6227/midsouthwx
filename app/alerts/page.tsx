import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

const STATUS_COLOR: Record<string, string> = {
  draft: 'text-wx-mute',
  queued: 'text-wx-accent',
  sending: 'text-wx-accent',
  sent: 'text-wx-ok',
  failed: 'text-wx-danger',
  cancelled: 'text-wx-mute',
  pending_approval: 'text-wx-accent',
};

export default async function AlertsPage() {
  const supa = supabaseServer();
  const { data: messages } = await supa
    .from('messages')
    .select('id, body_md, source, status, recipient_count, sent_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <DashShell
      title="Alerts"
      actions={<Link href="/compose" className="btn">New alert</Link>}
    >
      <section className="card divide-y divide-wx-line">
        {messages?.length ? (
          messages.map((m) => (
            <Link
              key={m.id}
              href={`/alerts/${m.id}`}
              className="flex items-center justify-between gap-4 p-4 hover:bg-wx-ink/40 transition"
            >
              <div className="min-w-0">
                <div className="truncate">{m.body_md.slice(0, 100)}</div>
                <div className="text-xs text-wx-mute mt-1">
                  <span className={STATUS_COLOR[m.status] ?? ''}>{m.status}</span>
                  {' · '}
                  {m.source}
                  {' · '}
                  {m.recipient_count ?? 0} recipients
                </div>
              </div>
              <div className="text-xs text-wx-mute whitespace-nowrap">
                {new Date(m.sent_at ?? m.created_at).toLocaleString()}
              </div>
            </Link>
          ))
        ) : (
          <p className="text-wx-mute text-sm p-5">No alerts yet. <Link href="/compose" className="text-wx-accent">Send your first →</Link></p>
        )}
      </section>
    </DashShell>
  );
}
