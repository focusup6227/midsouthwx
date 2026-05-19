import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';

export default async function DashboardHome() {
  const supa = supabaseServer();
  const [{ count: activeSubs }, { count: unread }, { count: groupCount }, { data: recent }] =
    await Promise.all([
      supa
        .from('subscribers')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active'),
      supa
        .from('replies')
        .select('*', { count: 'exact', head: true })
        .is('read_at', null),
      supa
        .from('custom_groups')
        .select('*', { count: 'exact', head: true }),
      supa
        .from('messages')
        .select('id, body_md, recipient_count, status, sent_at, created_at')
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

  const Tile = ({
    href, title, value, hint,
  }: {
    href: string; title: string; value: string | number; hint?: string;
  }) => (
    <Link href={href} className="card p-5 hover:border-wx-accent transition">
      <div className="text-xs uppercase tracking-wide text-wx-mute">{title}</div>
      <div className="text-3xl font-bold mt-1">{value}</div>
      {hint ? <div className="text-xs text-wx-mute mt-1">{hint}</div> : null}
    </Link>
  );

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mid-South WX</h1>
        <div className="flex gap-2">
          <Link href="/compose" className="btn">New alert</Link>
          <Link href="/inbox" className="btn-ghost">Inbox</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile href="/subscribers" title="Active subscribers" value={activeSubs ?? 0} />
        <Tile href="/inbox" title="Unread replies" value={unread ?? 0} />
        <Tile href="/groups" title="Groups" value={groupCount ?? 0} hint="Manage custom audiences" />
        <Tile href="/settings" title="Settings" value="·" hint="Bot, templates, profile" />
      </div>

      <section className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Recent alerts</h2>
          <Link href="/alerts" className="text-wx-accent text-sm">View all →</Link>
        </div>
        {recent?.length ? (
          <ul className="divide-y divide-wx-line">
            {recent.map((m) => (
              <li key={m.id} className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="truncate">{m.body_md.slice(0, 80)}</div>
                  <div className="text-xs text-wx-mute">
                    {m.status} · {m.recipient_count} recipients
                  </div>
                </div>
                <div className="text-xs text-wx-mute whitespace-nowrap">
                  {new Date(m.sent_at ?? m.created_at).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-wx-mute text-sm">No alerts yet. Send your first one →</p>
        )}
      </section>
    </main>
  );
}
