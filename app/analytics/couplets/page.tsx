import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

type TrackRow = {
  track_id: string;
  site: string;
  first_seen_at: string;
  last_seen_at: string;
  volume_count: number;
  max_shear_kt: number;
  had_tds: boolean;
  verified: boolean;
  warning_event: string | null;
};

function pct(part: number, total: number): string {
  if (total === 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

// Detection-quality report: how often did a flagged rotation end up inside /
// near a real Tornado Warning? Single-scan blips are broken out from
// persistent (2+ scan) tracks because they dominate the false-alarm noise —
// threshold tuning should look at the persistent row.
export default async function CoupletValidationPage({
  searchParams,
}: {
  searchParams?: { days?: string };
}) {
  const days = Math.min(180, Math.max(1, parseInt(searchParams?.days ?? '30', 10) || 30));
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('couplet_validation_tracks', { p_days: days });
  const tracks = (data ?? []) as TrackRow[];

  const sites = [...new Set(tracks.map((t) => t.site))].sort();
  const bySite = (site: string) => tracks.filter((t) => t.site === site);
  const stats = (rows: TrackRow[]) => {
    const persistent = rows.filter((r) => r.volume_count >= 2);
    return {
      total: rows.length,
      verified: rows.filter((r) => r.verified).length,
      tds: rows.filter((r) => r.had_tds).length,
      tdsVerified: rows.filter((r) => r.had_tds && r.verified).length,
      persistent: persistent.length,
      persistentVerified: persistent.filter((r) => r.verified).length,
    };
  };
  const overall = stats(tracks);

  return (
    <DashShell title="Rotation validation" backHref="/analytics/warnings" width="normal">
      <p className="text-sm text-wx-mute">
        Every couplet track from the last{' '}
        <span className="text-wx-fg font-semibold">{days} days</span> checked against Tornado
        Warnings (polygon within 10 km, window −10/+30 min). Use the persistent-track hit rate to
        tune <code className="text-wx-fg">min_shear_kt</code> and the TDS threshold per site.
        {' '}
        {[7, 30, 90].map((d) => (
          <Link
            key={d}
            href={`/analytics/couplets?days=${d}`}
            className={`mr-2 ${d === days ? 'text-wx-accent font-semibold' : 'text-wx-accent/70'}`}
          >
            {d}d
          </Link>
        ))}
      </p>

      {error ? (
        <div className="card border-wx-danger/50 p-4 text-sm text-wx-danger">
          {error.message} — has the <code>couplet_validation</code> migration been applied?
        </div>
      ) : null}

      <section className="card overflow-x-auto p-5">
        <h2 className="mb-3 font-semibold">Per-site hit rate</h2>
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-wx-mute">
            <tr>
              <th className="pb-2">Site</th>
              <th className="pb-2">Tracks</th>
              <th className="pb-2">Warned</th>
              <th className="pb-2">Persistent (2+)</th>
              <th className="pb-2">Persistent warned</th>
              <th className="pb-2">TDS flags</th>
              <th className="pb-2">TDS warned</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wx-line">
            {sites.map((site) => {
              const s = stats(bySite(site));
              return (
                <tr key={site}>
                  <td className="py-2 font-mono font-semibold">{site}</td>
                  <td className="py-2">{s.total}</td>
                  <td className="py-2">{s.verified} ({pct(s.verified, s.total)})</td>
                  <td className="py-2">{s.persistent}</td>
                  <td className="py-2 font-semibold text-wx-fg">
                    {s.persistentVerified} ({pct(s.persistentVerified, s.persistent)})
                  </td>
                  <td className="py-2">{s.tds}</td>
                  <td className="py-2">{s.tdsVerified} ({pct(s.tdsVerified, s.tds)})</td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-wx-line">
              <td className="py-2 font-semibold">All</td>
              <td className="py-2">{overall.total}</td>
              <td className="py-2">{overall.verified} ({pct(overall.verified, overall.total)})</td>
              <td className="py-2">{overall.persistent}</td>
              <td className="py-2 font-semibold text-wx-fg">
                {overall.persistentVerified} ({pct(overall.persistentVerified, overall.persistent)})
              </td>
              <td className="py-2">{overall.tds}</td>
              <td className="py-2">{overall.tdsVerified} ({pct(overall.tdsVerified, overall.tds)})</td>
            </tr>
          </tbody>
        </table>
        {tracks.length === 0 && !error ? (
          <p className="mt-3 text-sm text-wx-mute">
            No couplet tracks in this window. Rotation IDs only populate while couplet-poll finds
            strong gate-to-gate shear — check back after the next event.
          </p>
        ) : null}
      </section>

      {tracks.length > 0 ? (
        <section className="card overflow-x-auto p-5">
          <h2 className="mb-3 font-semibold">Recent tracks</h2>
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-wx-mute">
              <tr>
                <th className="pb-2">Track</th>
                <th className="pb-2">Peak shear</th>
                <th className="pb-2">Scans</th>
                <th className="pb-2">TDS</th>
                <th className="pb-2">Outcome</th>
                <th className="pb-2">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-wx-line">
              {tracks.slice(0, 50).map((t) => (
                <tr key={t.track_id}>
                  <td className="py-2 font-mono">{t.track_id}</td>
                  <td className="py-2">{Math.round(t.max_shear_kt)} kt</td>
                  <td className="py-2">{t.volume_count}</td>
                  <td className="py-2">{t.had_tds ? <span className="font-bold text-red-300">TDS</span> : '—'}</td>
                  <td className="py-2">
                    {t.verified ? (
                      <span className="text-wx-ok">warned</span>
                    ) : (
                      <span className="text-wx-mute">no warning</span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-wx-mute">
                    {new Date(t.last_seen_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </DashShell>
  );
}
