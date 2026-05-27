import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

type OverlapRow = {
  warning_id: string;
  nws_id: string;
  event: string;
  severity: string | null;
  headline: string | null;
  area_desc: string | null;
  effective: string;
  expires_at: string | null;
  report_id: string | null;
  report_hazard: string | null;
  report_status: string | null;
  report_lat: number | null;
  report_lon: number | null;
  report_place_name: string | null;
  report_at: string | null;
  minutes_into_warning: number | null;
};

type WarningGroup = {
  warning_id: string;
  nws_id: string;
  event: string;
  severity: string | null;
  headline: string | null;
  area_desc: string | null;
  effective: string;
  expires_at: string | null;
  reports: OverlapRow[];
};

function eventTint(event: string): string {
  const e = event.toLowerCase();
  if (e.includes('tornado')) return 'text-red-300';
  if (e.includes('severe thunderstorm')) return 'text-orange-300';
  if (e.includes('flash flood') || e.includes('flood')) return 'text-emerald-300';
  if (e.includes('winter')) return 'text-sky-300';
  return 'text-slate-300';
}

function statusTint(status: string | null): string {
  if (status === 'verified') return 'text-emerald-300';
  if (status === 'promoted') return 'text-sky-300';
  if (status === 'dismissed') return 'text-wx-mute line-through';
  return 'text-wx-accent';
}

export default async function WarningAnalyticsPage({
  searchParams,
}: { searchParams?: { hours?: string } }) {
  const hours = Math.max(1, Math.min(168, parseInt(searchParams?.hours ?? '24', 10) || 24));
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('warning_report_overlap', { p_hours: hours });

  const rows = ((data ?? []) as OverlapRow[]);
  const groups = new Map<string, WarningGroup>();
  for (const r of rows) {
    let g = groups.get(r.warning_id);
    if (!g) {
      g = {
        warning_id: r.warning_id,
        nws_id: r.nws_id,
        event: r.event,
        severity: r.severity,
        headline: r.headline,
        area_desc: r.area_desc,
        effective: r.effective,
        expires_at: r.expires_at,
        reports: [],
      };
      groups.set(r.warning_id, g);
    }
    if (r.report_id) g.reports.push(r);
  }
  const groupList = Array.from(groups.values()).sort(
    (a, b) => new Date(b.effective).getTime() - new Date(a.effective).getTime(),
  );

  const totalWarnings = groupList.length;
  const confirmedWarnings = groupList.filter((g) => g.reports.length > 0).length;
  const totalReports = groupList.reduce((acc, g) => acc + g.reports.length, 0);

  return (
    <DashShell
      title="Warning verification"
      width="wide"
      actions={<Link href="/reports" className="btn-ghost text-sm">Triage</Link>}
    >
      <p className="text-wx-mute text-sm">
        For each NWS warning issued in the AOR, the spotter reports that
        landed inside its polygon within ±60 min. Confirmed warnings build
        trust over time; unconfirmed ones are worth a post-event review.
      </p>

      <div className="grid grid-cols-3 gap-2 my-3">
        <Tile label="Warnings" value={totalWarnings} sub={`last ${hours}h`} />
        <Tile
          label="Confirmed by spotters"
          value={confirmedWarnings}
          sub={totalWarnings > 0 ? `${Math.round((confirmedWarnings / totalWarnings) * 100)}%` : '—'}
          tint="text-emerald-300"
        />
        <Tile label="Total spotter reports inside polygons" value={totalReports} />
      </div>

      <div className="flex flex-wrap gap-1 items-center my-3 text-[11px] text-wx-mute">
        Window:
        {[6, 12, 24, 72, 168].map((h) => (
          <Link
            key={h}
            href={`/analytics/warnings?hours=${h}`}
            className={
              'px-2 py-0.5 rounded ' +
              (hours === h ? 'bg-wx-line text-wx-fg' : 'hover:text-wx-fg')
            }
          >
            {h < 168 ? `${h}h` : '7d'}
          </Link>
        ))}
      </div>

      {error ? (
        <div className="text-wx-danger text-sm">RPC error: {error.message}</div>
      ) : null}

      {groupList.length === 0 ? (
        <p className="text-wx-mute text-sm">No warnings in this window.</p>
      ) : (
        <ul className="space-y-2">
          {groupList.map((g) => {
            const confirmed = g.reports.length > 0;
            return (
              <li key={g.warning_id} className="card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className={`text-sm font-semibold ${eventTint(g.event)}`}>
                      {g.event}
                    </div>
                    {g.area_desc ? (
                      <div className="text-[11px] text-wx-mute line-clamp-2">{g.area_desc}</div>
                    ) : null}
                    <div className="text-[10px] font-mono text-wx-mute">
                      {new Date(g.effective).toLocaleString()} – {g.expires_at ? new Date(g.expires_at).toLocaleString() : '—'}
                    </div>
                  </div>
                  <span
                    className={
                      'shrink-0 text-[10px] uppercase tracking-wider font-semibold ' +
                      (confirmed ? 'text-emerald-300' : 'text-wx-mute')
                    }
                  >
                    {confirmed ? `${g.reports.length} report${g.reports.length === 1 ? '' : 's'}` : 'No reports'}
                  </span>
                </div>
                {g.reports.length > 0 ? (
                  <ul className="mt-2 divide-y divide-wx-line/60 text-[11px]">
                    {g.reports.map((r) => (
                      <li key={r.report_id} className="py-1.5 flex items-baseline gap-2">
                        <span className={`uppercase font-mono ${statusTint(r.report_status)}`}>
                          {r.report_status}
                        </span>
                        <span>{r.report_hazard}</span>
                        <span className="text-wx-mute truncate">
                          {r.report_place_name ?? (r.report_lat != null ? `${r.report_lat.toFixed(2)}, ${(r.report_lon ?? 0).toFixed(2)}` : '—')}
                        </span>
                        <span className="ml-auto text-[10px] text-wx-mute">
                          {r.minutes_into_warning != null
                            ? `${Math.round(r.minutes_into_warning)} min into warning`
                            : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </DashShell>
  );
}

function Tile({
  label,
  value,
  sub,
  tint,
}: { label: string; value: number; sub?: string; tint?: string }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wider text-wx-mute">{label}</div>
      <div className={`text-2xl font-semibold ${tint ?? ''}`}>{value}</div>
      {sub ? <div className="text-[10px] text-wx-mute">{sub}</div> : null}
    </div>
  );
}
