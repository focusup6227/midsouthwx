import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-wx-mute',
  active: 'text-wx-ok',
  paused: 'text-wx-accent',
  unsubscribed: 'text-wx-danger',
};

export default async function SubscribersPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const supa = supabaseServer();

  const status = searchParams.status;
  let q = supa
    .from('subscribers')
    .select('id, display_name, telegram_chat_id, telegram_username, status, zip, county_fips, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (status && ['pending', 'active', 'paused', 'unsubscribed'].includes(status)) {
    q = q.eq('status', status);
  }
  const { data: subs } = await q;

  const filterLink = (val: string | undefined, label: string) => (
    <Link
      href={val ? `/subscribers?status=${val}` : '/subscribers'}
      className={`btn-ghost text-sm ${status === val || (!status && !val) ? 'border-wx-accent text-wx-accent' : ''}`}
    >
      {label}
    </Link>
  );

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/dashboard" className="text-wx-mute text-sm">← Dashboard</Link>
          <h1 className="text-2xl font-bold">Subscribers</h1>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {filterLink(undefined, 'All')}
        {filterLink('active', 'Active')}
        {filterLink('pending', 'Pending')}
        {filterLink('paused', 'Paused')}
        {filterLink('unsubscribed', 'Unsubscribed')}
      </div>

      <section className="card divide-y divide-wx-line">
        {subs?.length ? (
          subs.map((s) => (
            <Link
              key={s.id}
              href={`/subscribers/${s.id}`}
              className="flex items-center justify-between gap-4 p-4 hover:bg-wx-ink/40 transition"
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{s.display_name}</div>
                <div className="text-xs text-wx-mute mt-0.5">
                  <span className={STATUS_COLOR[s.status] ?? ''}>{s.status}</span>
                  {' · '}
                  {s.telegram_chat_id ? 'linked' : 'not linked'}
                  {s.zip ? ` · ZIP ${s.zip}` : ''}
                  {s.county_fips ? ` · FIPS ${s.county_fips}` : ''}
                </div>
              </div>
              <div className="text-xs text-wx-mute whitespace-nowrap">
                {new Date(s.created_at).toLocaleDateString()}
              </div>
            </Link>
          ))
        ) : (
          <p className="text-wx-mute text-sm p-5">No subscribers yet.</p>
        )}
      </section>
    </main>
  );
}
