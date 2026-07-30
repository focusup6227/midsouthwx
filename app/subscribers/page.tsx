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

type Params = { status?: string; region?: string; q?: string; linked?: string };

export default async function SubscribersPage({ searchParams }: { searchParams: Params }) {
  const supa = supabaseServer();

  const status = searchParams.status;
  const regionId = searchParams.region;
  // Strip characters that would break the PostgREST or() filter syntax.
  const search = (searchParams.q ?? '').replace(/[%_,()]/g, '').trim().slice(0, 64);
  const linked = searchParams.linked === '1' ? true : searchParams.linked === '0' ? false : null;

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
  if (search) {
    const filters = [`display_name.ilike.%${search}%`, `telegram_username.ilike.%${search}%`];
    if (/^\d+$/.test(search)) filters.push(`zip.like.${search}%`);
    q = q.or(filters.join(','));
  }
  if (linked === true) q = q.not('telegram_chat_id', 'is', null);
  if (linked === false) q = q.is('telegram_chat_id', null);
  if (subscriberIdsForRegion) {
    if (subscriberIdsForRegion.length === 0) {
      q = q.eq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      q = q.in('id', subscriberIdsForRegion);
    }
  }
  const { data: subs } = await q;

  const baseParams = (next: Params) => {
    const params = new URLSearchParams();
    if (next.status) params.set('status', next.status);
    if (next.region) params.set('region', next.region);
    if (next.q) params.set('q', next.q);
    if (next.linked !== undefined && next.linked !== '') params.set('linked', next.linked);
    const qs = params.toString();
    return qs ? `/subscribers?${qs}` : '/subscribers';
  };

  const current: Params = {
    status,
    region: regionId,
    q: search || undefined,
    linked: searchParams.linked,
  };

  const filterLink = (val: string | undefined, label: string) => (
    <Link
      href={baseParams({ ...current, status: val })}
      className={`btn-ghost text-sm ${status === val || (!status && !val) ? 'border-wx-accent text-wx-accent' : ''}`}
    >
      {label}
    </Link>
  );

  const linkedLink = (val: string | undefined, label: string) => (
    <Link
      href={baseParams({ ...current, linked: val })}
      className={`btn-ghost text-sm ${
        searchParams.linked === val || (!searchParams.linked && !val) ? 'border-wx-accent text-wx-accent' : ''
      }`}
    >
      {label}
    </Link>
  );

  return (
    <DashShell
      title="Subscribers"
      width="wide"
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
            href={baseParams({ ...current, region: undefined })}
            className="text-xs text-wx-mute hover:text-wx-fg"
          >
            Clear ✕
          </Link>
        </div>
      ) : null}

      <form action="/subscribers" className="flex flex-wrap items-center gap-2">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        {regionId ? <input type="hidden" name="region" value={regionId} /> : null}
        {searchParams.linked ? <input type="hidden" name="linked" value={searchParams.linked} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Search name, @username, or ZIP…"
          className="input w-full max-w-sm"
          aria-label="Search subscribers"
        />
        <button type="submit" className="btn-ghost text-sm">
          Search
        </button>
        {search ? (
          <Link href={baseParams({ ...current, q: undefined })} className="text-xs text-wx-mute hover:text-wx-fg">
            Clear ✕
          </Link>
        ) : null}
      </form>

      <div className="flex flex-wrap items-center gap-2">
        {filterLink(undefined, 'All')}
        {filterLink('active', 'Active')}
        {filterLink('pending', 'Pending')}
        {filterLink('paused', 'Paused')}
        {filterLink('unsubscribed', 'Unsubscribed')}
        <span className="mx-1 h-5 w-px bg-wx-line" aria-hidden />
        {linkedLink(undefined, 'Any Telegram')}
        {linkedLink('1', 'Linked')}
        {linkedLink('0', 'Unlinked')}
        <span className="ml-auto text-xs text-wx-mute">
          {subs?.length ?? 0}
          {(subs?.length ?? 0) === 500 ? '+' : ''} shown
        </span>
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
                  {s.telegram_username ? (
                    <span className="text-xs font-normal text-wx-mute">@{s.telegram_username}</span>
                  ) : null}
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
                  <span className={s.telegram_chat_id ? '' : 'text-wx-danger'}>
                    {s.telegram_chat_id ? 'linked' : 'not linked'}
                  </span>
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
              {search
                ? `No subscribers match “${search}”.`
                : regionInfo
                  ? 'No subscribers in this region.'
                  : 'No subscribers yet.'}
            </p>
            {!regionInfo && !search && (
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
