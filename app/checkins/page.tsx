import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';
import CheckinsRealtime from './CheckinsRealtime';

export const dynamic = 'force-dynamic';

type Rollup = {
  message_id: string;
  created_at: string;
  sent_at: string | null;
  body_md: string;
  status: string;
  recipient_count: number;
  delivered_count: number;
  safe_count: number;
  distress_count: number;
  other_count: number;
  responded_count: number;
  unreached_count: number;
};

function pct(n: number, d: number): string {
  if (!d) return '—';
  const p = Math.round((n / d) * 100);
  return `${p}%`;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffMin = Math.round((Date.now() - t) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h ago`;
  return `${Math.round(diffMin / 60 / 24)}d ago`;
}

export default async function CheckinsPage({
  searchParams,
}: {
  searchParams: { hours?: string };
}) {
  const supa = supabaseServer();

  const hoursParam = parseInt(searchParams.hours ?? '', 10);
  const hours = Number.isFinite(hoursParam) ? Math.max(1, Math.min(168, hoursParam)) : 24;

  const { data, error } = await supa.rpc('checkin_rollups', { p_hours: hours });
  const rollups: Rollup[] = (data ?? []) as Rollup[];

  const totals = rollups.reduce(
    (acc, r) => ({
      safe: acc.safe + r.safe_count,
      distress: acc.distress + r.distress_count,
      unreached: acc.unreached + r.unreached_count,
      sent: acc.sent + (r.recipient_count ?? 0),
    }),
    { safe: 0, distress: 0, unreached: 0, sent: 0 },
  );

  return (
    <DashShell
      title="Check-ins"
      actions={<Link href="/compose" className="btn">New alert</Link>}
    >
      <CheckinsRealtime />

      <section className="card p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">Safe</div>
          <div className="text-2xl font-bold text-wx-ok mt-1">{totals.safe}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">Need help</div>
          <div className={`text-2xl font-bold mt-1 ${totals.distress > 0 ? 'text-wx-danger' : 'text-wx-mute'}`}>
            {totals.distress}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">Unreached</div>
          <div className="text-2xl font-bold text-wx-mute mt-1">{totals.unreached}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-wx-mute font-semibold">
            Across {rollups.length} check-in{rollups.length === 1 ? '' : 's'}
          </div>
          <div className="text-sm text-wx-mute mt-1">
            Last {hours}h · {totals.sent} recipients total
          </div>
        </div>
      </section>

      {error ? (
        <p className="text-sm text-wx-danger">checkin_rollups failed: {error.message}</p>
      ) : null}

      <section className="card divide-y divide-wx-line">
        {rollups.length === 0 ? (
          <p className="p-6 text-sm text-wx-mute">
            No check-in messages sent in the last {hours}h. Toggle{' '}
            <span className="font-semibold">Safety check-in</span> on{' '}
            <Link href="/compose" className="text-wx-accent">/compose</Link> to attach Y/N buttons
            to your next alert.
          </p>
        ) : (
          rollups.map((r) => {
            const denom = r.recipient_count || r.delivered_count || 1;
            return (
              <Link
                key={r.message_id}
                href={`/alerts/${r.message_id}`}
                className="block p-4 hover:bg-wx-ink/40 transition"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-wx-fg/90 line-clamp-2">{r.body_md}</p>
                    <div className="text-[11px] text-wx-mute mt-1 font-mono">
                      {timeAgo(r.sent_at ?? r.created_at)} · status {r.status} ·{' '}
                      {r.recipient_count} recipient{r.recipient_count === 1 ? '' : 's'}
                      {r.delivered_count !== r.recipient_count
                        ? ` · ${r.delivered_count} reached`
                        : ''}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-center shrink-0">
                    <div>
                      <div className="text-base font-bold text-wx-ok">{r.safe_count}</div>
                      <div className="text-[9.5px] uppercase tracking-wider text-wx-mute">Safe</div>
                      <div className="text-[10px] text-wx-mute font-mono">{pct(r.safe_count, denom)}</div>
                    </div>
                    <div>
                      <div className={`text-base font-bold ${r.distress_count > 0 ? 'text-wx-danger' : 'text-wx-mute'}`}>
                        {r.distress_count}
                      </div>
                      <div className="text-[9.5px] uppercase tracking-wider text-wx-mute">Help</div>
                      <div className="text-[10px] text-wx-mute font-mono">{pct(r.distress_count, denom)}</div>
                    </div>
                    <div>
                      <div className="text-base font-bold text-wx-mute">{r.unreached_count}</div>
                      <div className="text-[9.5px] uppercase tracking-wider text-wx-mute">Unreached</div>
                      <div className="text-[10px] text-wx-mute font-mono">{pct(r.unreached_count, denom)}</div>
                    </div>
                  </div>
                </div>
                {r.other_count > 0 ? (
                  <div className="text-[10.5px] text-wx-mute mt-2">
                    + {r.other_count} other response{r.other_count === 1 ? '' : 's'}
                  </div>
                ) : null}
              </Link>
            );
          })
        )}
      </section>
    </DashShell>
  );
}
