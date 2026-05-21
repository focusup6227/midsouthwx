import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import DashShell from '@/components/DashShell';

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
    .select('id, display_name, telegram_chat_id, telegram_username, status, zip, county_fips, created_at, location')
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
    <DashShell
      title="Subscribers"
      actions={<Link href="/subscribers/invite" className="btn">Invite subscriber</Link>}
    >
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
                <div className="font-medium truncate flex items-center gap-2">
                  {s.display_name}
                  {!s.location && (
                    <span
                      className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-wx-danger/40 text-wx-danger"
                      title="No coordinates on file — radar polygon/circle alerts won't reach this subscriber"
                    >
                      no location
                    </span>
                  )}
                </div>
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
          <div className="p-5 space-y-3">
            <p className="text-wx-mute text-sm">No subscribers yet.</p>
            <p className="text-sm">
              <Link href="/subscribers/invite" className="text-wx-accent">
                Invite your first subscriber →
              </Link>
            </p>
          </div>
        )}
      </section>
    </DashShell>
  );
}
