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
  searchParams: { status?: string; region?: string };
}) {
  const supa = supabaseServer();

  const status = searchParams.status;
  const regionId = searchParams.region;

  let regionInfo: { id: string; name: string } | null = null;
  let subscriberIdsForRegion: string[] | null = null;
  if (regionId) {
    const [{ data: region }, { data: memberships }] = await Promise.all([
      supa.from('regions').select('id, name').eq('id', regionId).maybeSingle(),
      supa.from('subscriber_regions').select('subscriber_id').eq('region_id', regionId),
    ]);
    regionInfo = region ?? null;
    subscriberIdsForRegion = (memberships ?? []).map((m) => m.subscriber_id);
  }

  let q = supa
    .from('subscribers')
    .select('id, display_name, telegram_chat_id, telegram_username, status, zip, county_fips, created_at, location')
    .order('created_at', { ascending: false })
    .limit(500);
  if (status && ['pending', 'active', 'paused', 'unsubscribed'].includes(status)) {
    q = q.eq('status', status);
  }
  if (subscriberIdsForRegion) {
    if (subscriberIdsForRegion.length === 0) {
      q = q.eq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      q = q.in('id', subscriberIdsForRegion);
    }
  }
  const { data: subs } = await q;

  const baseParams = (next: { status?: string; region?: string }) => {
    const params = new URLSearchParams();
    if (next.status) params.set('status', next.status);
    if (next.region) params.set('region', next.region);
    const qs = params.toString();
    return qs ? `/subscribers?${qs}` : '/subscribers';
  };

  const filterLink = (val: string | undefined, label: string) => (
    <Link
      href={baseParams({ status: val, region: regionId })}
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
      {regionInfo ? (
        <div className="flex items-center justify-between gap-3 rounded border border-wx-line bg-wx-ink/40 px-3 py-2 text-sm">
          <div>
            Filtered by region:{' '}
            <Link href={`/regions/${regionInfo.id}`} className="text-wx-accent">
              {regionInfo.name}
            </Link>
          </div>
          <Link
            href={baseParams({ status })}
            className="text-xs text-wx-mute hover:text-wx-fg"
          >
            Clear ✕
          </Link>
        </div>
      ) : null}

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
            <p className="text-wx-mute text-sm">
              {regionInfo ? 'No subscribers in this region.' : 'No subscribers yet.'}
            </p>
            {!regionInfo && (
              <p className="text-sm">
                <Link href="/subscribers/invite" className="text-wx-accent">
                  Invite your first subscriber →
                </Link>
              </p>
            )}
          </div>
        )}
      </section>
    </DashShell>
  );
}
