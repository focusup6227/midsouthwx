import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import DashShell, { isFieldMode } from '@/components/DashShell';
import ReportActions from './ReportActions';
import { fetchSpotterStats, summarizeReliability } from './spotter-stats';

export const dynamic = 'force-dynamic';

const HAZARD_LABEL: Record<string, string> = {
  tornado: 'Tornado',
  funnel: 'Funnel cloud',
  wind: 'Damaging wind',
  hail: 'Hail',
  flood: 'Flooding',
  other: 'Severe weather',
};

const HAZARD_TINT: Record<string, string> = {
  tornado: 'text-red-300',
  funnel: 'text-rose-200',
  wind: 'text-violet-200',
  hail: 'text-orange-200',
  flood: 'text-emerald-200',
  other: 'text-slate-300',
};

const STATUS_TINT: Record<string, string> = {
  new: 'text-wx-accent',
  verified: 'text-emerald-300',
  promoted: 'text-sky-300',
  dismissed: 'text-wx-mute',
};

type SearchParams = { status?: string; hours?: string };

export default async function ReportsTriagePage({
  searchParams,
}: { searchParams?: SearchParams }) {
  const supa = supabaseServer();
  const field = await isFieldMode();
  // Field mode forces "needs triage" as the default + tightens the card
  // grid to one big column for thumb reach on a phone during an active event.
  const statusFilter = searchParams?.status ?? 'open';
  const hours = Math.max(1, Math.min(168, parseInt(searchParams?.hours ?? '24', 10) || 24));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  let query = supa
    .from('telegram_storm_reports')
    .select('id, hazard, description, photo_url, lat, lon, place_name, status, reported_at, verified_at, dismissed_at, promoted_at, promoted_message_id, last_forwarded_at, forward_count, subscriber_id, subscriber:subscribers(display_name, telegram_username)')
    .gte('reported_at', since)
    .order('reported_at', { ascending: false })
    .limit(200);
  if (statusFilter === 'open') {
    query = query.in('status', ['new', 'verified']);
  } else if (statusFilter !== 'all') {
    query = query.eq('status', statusFilter);
  }
  const { data: rows } = await query;

  const subscriberIds = Array.from(new Set((rows ?? []).map((r) => r.subscriber_id).filter(Boolean) as string[]));
  const spotterStats = await fetchSpotterStats(subscriberIds);

  const totals = await supa
    .from('telegram_storm_reports')
    .select('status')
    .gte('reported_at', since);
  const counts = { new: 0, verified: 0, promoted: 0, dismissed: 0 } as Record<string, number>;
  for (const r of totals.data ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;

  const filters: { key: string; label: string; count?: number }[] = [
    { key: 'open', label: 'Needs triage', count: counts.new + counts.verified },
    { key: 'new', label: 'New', count: counts.new },
    { key: 'verified', label: 'Verified', count: counts.verified },
    { key: 'promoted', label: 'Promoted', count: counts.promoted },
    { key: 'dismissed', label: 'Dismissed', count: counts.dismissed },
    { key: 'all', label: 'All' },
  ];

  return (
    <DashShell
      title="Storm reports"
      width="wide"
      actions={<Link href="/radar" className="btn-ghost text-sm">Open radar</Link>}
    >
      <p className="text-wx-mute text-sm">
        Subscriber-submitted reports from the Telegram <code className="text-xs">/report</code> flow.
        Verify ground truth, dismiss noise, or promote a confirmed sighting to a broadcast.
      </p>

      <div className="flex flex-wrap gap-2 my-3">
        {filters.map((f) => {
          const active = (statusFilter || 'open') === f.key;
          return (
            <Link
              key={f.key}
              href={`/reports?status=${f.key}&hours=${hours}`}
              className={
                'text-xs px-2.5 py-1 rounded-full border ' +
                (active
                  ? 'bg-wx-accent/15 border-wx-accent text-wx-accent'
                  : 'border-wx-line text-wx-mute hover:text-wx-fg')
              }
            >
              {f.label}{typeof f.count === 'number' ? ` · ${f.count}` : ''}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-1 text-[11px] text-wx-mute">
          Window:
          {[6, 24, 72, 168].map((h) => (
            <Link
              key={h}
              href={`/reports?status=${statusFilter}&hours=${h}`}
              className={
                'px-2 py-0.5 rounded ' +
                (hours === h ? 'bg-wx-line text-wx-fg' : 'hover:text-wx-fg')
              }
            >
              {h < 168 ? `${h}h` : '7d'}
            </Link>
          ))}
        </div>
      </div>

      {!rows?.length ? (
        <p className="text-wx-mute text-sm">No reports in this window.</p>
      ) : (
        <ul className={field ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
          {rows.map((r) => {
            const sub = Array.isArray(r.subscriber) ? r.subscriber[0] : r.subscriber;
            const reporter = sub?.telegram_username
              ? `@${sub.telegram_username}`
              : sub?.display_name ?? 'subscriber';
            const when = new Date(r.reported_at).toLocaleString([], {
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            });
            const ageMin = Math.max(0, Math.round((Date.now() - new Date(r.reported_at).getTime()) / 60_000));
            const ageLabel = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
            return (
              <li
                key={r.id}
                className="card p-3 space-y-2 flex flex-col"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <div className={`text-[13px] font-semibold ${HAZARD_TINT[r.hazard] ?? ''}`}>
                      {HAZARD_LABEL[r.hazard] ?? r.hazard}
                    </div>
                    <div className="text-[11px] text-wx-mute truncate">
                      {r.place_name ?? `${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`}
                    </div>
                  </div>
                  <span className={`text-[10px] uppercase tracking-wider font-semibold ${STATUS_TINT[r.status] ?? ''}`}>
                    {r.status}
                  </span>
                </div>

                {r.photo_url ? (
                  <a
                    href={r.photo_url}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded-md overflow-hidden border border-wx-line"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.photo_url}
                      alt="Subscriber storm report"
                      className="w-full max-h-56 object-cover bg-wx-ink"
                      loading="lazy"
                    />
                  </a>
                ) : (
                  <div className="text-[11px] text-wx-mute italic">No photo</div>
                )}

                {r.description ? (
                  <p className="text-[11.5px] text-wx-fg/85 italic line-clamp-4">
                    &quot;{r.description}&quot;
                  </p>
                ) : null}

                <div className="text-[10px] font-mono text-wx-mute flex justify-between items-center mt-auto pt-1 gap-2">
                  <span className="truncate flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{reporter}</span>
                    {(() => {
                      const rel = summarizeReliability(r.subscriber_id ? spotterStats.get(r.subscriber_id) : undefined);
                      if (!rel) return null;
                      return (
                        <span
                          className={`shrink-0 inline-flex items-center rounded px-1 py-px text-[9px] bg-wx-ink/80 ${rel.tint}`}
                          title={`Spotter has ${rel.confirmed} confirmed of ${rel.total} reports`}
                        >
                          ⭐ {rel.confirmed}/{rel.total}
                        </span>
                      );
                    })()}
                    {r.last_forwarded_at ? (
                      <span
                        className="shrink-0 inline-flex items-center rounded px-1 py-px text-[9px] bg-wx-ink/80 text-sky-300"
                        title={`Forwarded ${r.forward_count ?? 1}× to nearby subscribers`}
                      >
                        📷 forwarded
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0">{when} · {ageLabel}</span>
                </div>

                <ReportActions
                  id={r.id}
                  status={r.status}
                  promotedMessageId={r.promoted_message_id}
                  hasPhoto={Boolean(r.photo_url)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </DashShell>
  );
}
