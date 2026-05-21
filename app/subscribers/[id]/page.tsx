import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import SubscriberActions from './SubscriberActions';
import LocationCard from './LocationCard';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

export default async function SubscriberDetail({ params }: { params: { id: string } }) {
  const supa = supabaseServer();

  const { data: sub } = await supa
    .from('subscribers')
    .select('id, display_name, telegram_chat_id, telegram_username, phone, email, status, zip, county_fips, home_address, current_address, current_address_updated_at, link_token, link_expires_at, created_at, location')
    .eq('id', params.id)
    .single();

  if (!sub) notFound();

  const [regionsRes, groupsRes, deliveriesRes, repliesCountRes] = await Promise.all([
    supa
      .from('subscriber_regions')
      .select('region_id, regions(id, name, kind)')
      .eq('subscriber_id', params.id),
    supa
      .from('group_memberships')
      .select('group_id, custom_groups(id, name)')
      .eq('subscriber_id', params.id),
    supa
      .from('delivery_logs')
      .select('id, event, occurred_at, message_id')
      .eq('subscriber_id', params.id)
      .order('occurred_at', { ascending: false })
      .limit(10),
    supa
      .from('replies')
      .select('id', { count: 'exact', head: true })
      .eq('subscriber_id', params.id),
  ]);

  return (
    <DashShell title={sub.display_name} backHref="/subscribers" width="narrow">
      <p className="text-xs text-wx-mute">status {sub.status}</p>

      {sub.current_address && (
        <section className="card p-5 space-y-1 border-wx-accent">
          <h2 className="font-semibold text-wx-accent">📍 Currently at (not home)</h2>
          <p className="text-sm whitespace-pre-wrap">{sub.current_address}</p>
          {sub.current_address_updated_at && (
            <p className="text-xs text-wx-mute">
              Updated {new Date(sub.current_address_updated_at).toLocaleString()}
            </p>
          )}
        </section>
      )}

      <section className="card p-5 space-y-2">
        <h2 className="font-semibold">Contact</h2>
        <dl className="text-sm grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1">
          <dt className="text-wx-mute">Telegram</dt>
          <dd>
            {sub.telegram_chat_id ? (
              <>
                chat id {sub.telegram_chat_id}
                {sub.telegram_username ? ` (@${sub.telegram_username})` : ''}
              </>
            ) : (
              <span className="text-wx-mute">Not linked</span>
            )}
          </dd>
          <dt className="text-wx-mute">Email</dt>
          <dd>{sub.email ?? <span className="text-wx-mute">—</span>}</dd>
          <dt className="text-wx-mute">Phone</dt>
          <dd>{sub.phone ?? <span className="text-wx-mute">—</span>}</dd>
          <dt className="text-wx-mute">ZIP</dt>
          <dd>{sub.zip ?? <span className="text-wx-mute">—</span>}</dd>
          <dt className="text-wx-mute">County FIPS</dt>
          <dd>{sub.county_fips ?? <span className="text-wx-mute">—</span>}</dd>
          <dt className="text-wx-mute">Home address</dt>
          <dd className="whitespace-pre-wrap">{sub.home_address ?? <span className="text-wx-mute">—</span>}</dd>
          <dt className="text-wx-mute">Joined</dt>
          <dd>{new Date(sub.created_at).toLocaleString()}</dd>
          {!sub.telegram_chat_id && sub.link_token && (
            <>
              <dt className="text-wx-mute">Link token</dt>
              <dd className="font-mono text-xs break-all">{sub.link_token}</dd>
            </>
          )}
        </dl>
      </section>

      <SubscriberActions id={sub.id} status={sub.status} />

      <LocationCard
        id={sub.id}
        hasLocation={Boolean(sub.location)}
        hasAddress={Boolean(sub.home_address)}
        hasZip={Boolean(sub.zip)}
      />

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Region memberships</h2>
        {regionsRes.data?.length ? (
          <ul className="text-sm space-y-1">
            {regionsRes.data.map((row) => {
              const r = Array.isArray(row.regions) ? row.regions[0] : row.regions;
              return (
                <li key={row.region_id}>
                  {r?.name ?? row.region_id} <span className="text-wx-mute">({r?.kind ?? '—'})</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-wx-mute text-sm">No matching regions.</p>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Groups</h2>
        {groupsRes.data?.length ? (
          <ul className="text-sm space-y-1">
            {groupsRes.data.map((row) => {
              const g = Array.isArray(row.custom_groups) ? row.custom_groups[0] : row.custom_groups;
              return (
                <li key={row.group_id}>
                  <Link href={`/groups/${row.group_id}`} className="text-wx-accent">
                    {g?.name ?? row.group_id}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-wx-mute text-sm">Not in any group.</p>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Recent deliveries</h2>
        {deliveriesRes.data?.length ? (
          <ul className="text-sm space-y-1">
            {deliveriesRes.data.map((d) => (
              <li key={d.id} className="flex justify-between gap-2">
                <Link href={`/alerts/${d.message_id}`} className="text-wx-accent">
                  {d.event}
                </Link>
                <span className="text-wx-mute text-xs">
                  {new Date(d.occurred_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-wx-mute text-sm">No deliveries yet.</p>
        )}
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">Replies</h2>
        <p className="text-sm mt-1">
          <strong>{repliesCountRes.count ?? 0}</strong> total
        </p>
      </section>
    </DashShell>
  );
}
