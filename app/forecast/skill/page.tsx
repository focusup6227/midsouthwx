import Link from 'next/link';
import DashShell from '@/components/DashShell';
import { supabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Forecast skill dashboard — aggregates the per-forecast `verification` jsonb
// (populated by the hourly forecast-verify cron via score_forecast) across all
// scored forecasts in a window, into rolling contingency stats: POD / FAR / CSI
// overall and per hazard, plus confidence reliability (did "High" verify more
// often than "Low"?). Read-only aggregation in TS — no new DB function needed.
//
// Distinct from /analytics/warnings ("Verification" nav), which scores NWS
// *warnings* vs LSRs. This scores the operator's own *forecasts*.

const HAZARDS = ['tornado', 'severe', 'flood', 'wind', 'winter', 'heat'] as const;
type Hazard = (typeof HAZARDS)[number];

const WINDOWS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 0, label: 'All time' },
];

type Verification = {
  skill?: { hits?: number; misses?: number; false_alarms?: number };
  matched_hazards?: string[];
  missed_hazards?: string[];
  false_alarm_hazards?: string[];
  hazard_match?: boolean;
};
type Row = {
  id: string;
  title: string;
  confidence: string | null;
  hazards: string[] | null;
  valid_until: string;
  verification: Verification | null;
};

type Contingency = { hits: number; misses: number; fa: number };

function pod(c: Contingency): number | null {
  const d = c.hits + c.misses;
  return d === 0 ? null : c.hits / d;
}
function far(c: Contingency): number | null {
  const d = c.hits + c.fa;
  return d === 0 ? null : c.fa / d;
}
function csi(c: Contingency): number | null {
  const d = c.hits + c.misses + c.fa;
  return d === 0 ? null : c.hits / d;
}
function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}
function toneFor(metric: 'pod' | 'far' | 'csi', v: number | null): string {
  if (v == null) return 'text-wx-mute';
  // POD/CSI higher = better; FAR lower = better.
  const good = metric === 'far' ? v <= 0.3 : v >= 0.6;
  const mid = metric === 'far' ? v <= 0.5 : v >= 0.4;
  return good ? 'text-wx-ok' : mid ? 'text-yellow-400' : 'text-wx-danger';
}

function faHazards(v: Verification, forecastHazards: string[]): string[] {
  if (v.false_alarm_hazards) return v.false_alarm_hazards;
  // Older verifications: forecast hazards that weren't matched.
  const matched = new Set(v.matched_hazards ?? []);
  return forecastHazards.filter((h) => !matched.has(h));
}

function Metric({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="rounded-md border border-wx-line bg-wx-ink p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">{label}</div>
      <div className={`mt-0.5 text-2xl font-bold leading-none ${tone ?? 'text-wx-fg'}`}>{value}</div>
      {sub ? <div className="mt-1 text-[10px] text-wx-mute">{sub}</div> : null}
    </div>
  );
}

export default async function ForecastSkillPage({ searchParams }: { searchParams?: { days?: string } }) {
  const days = WINDOWS.some((w) => String(w.days) === searchParams?.days)
    ? Number(searchParams!.days)
    : 90;

  const supa = supabaseServer();
  let q = supa
    .from('forecasts')
    .select('id, title, confidence, hazards, valid_until, verification')
    .not('verification', 'is', null)
    .order('valid_until', { ascending: false })
    .limit(500);
  if (days > 0) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    q = q.gte('valid_until', since);
  }
  const { data, error } = await q;
  const rows = (data ?? []) as Row[];

  // Overall + per-hazard contingency.
  const overall: Contingency = { hits: 0, misses: 0, fa: 0 };
  const byHazard: Record<Hazard, Contingency> = Object.fromEntries(
    HAZARDS.map((h) => [h, { hits: 0, misses: 0, fa: 0 }]),
  ) as Record<Hazard, Contingency>;
  // Confidence reliability.
  const byConf: Record<string, { n: number; verified: number }> = {};
  let verifiedCount = 0;

  for (const r of rows) {
    const v = r.verification ?? {};
    const matched = v.matched_hazards ?? [];
    const missed = v.missed_hazards ?? [];
    const fa = faHazards(v, r.hazards ?? []);
    overall.hits += matched.length;
    overall.misses += missed.length;
    overall.fa += fa.length;
    for (const h of matched) if (h in byHazard) byHazard[h as Hazard].hits++;
    for (const h of missed) if (h in byHazard) byHazard[h as Hazard].misses++;
    for (const h of fa) if (h in byHazard) byHazard[h as Hazard].fa++;

    const conf = r.confidence ?? '—';
    byConf[conf] ??= { n: 0, verified: 0 };
    byConf[conf].n++;
    const ok = v.hazard_match ?? matched.length > 0;
    if (ok) { byConf[conf].verified++; verifiedCount++; }
  }

  const confOrder = ['high', 'moderate', 'low', '—'];

  return (
    <DashShell
      title="Forecast skill"
      width="wide"
      backHref="/forecast"
      actions={
        <div className="flex flex-wrap gap-1">
          {WINDOWS.map((w) => (
            <Link
              key={w.days}
              href={`/forecast/skill?days=${w.days}`}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                w.days === days ? 'border-wx-accent text-wx-accent' : 'border-wx-line text-wx-mute hover:text-wx-fg'
              }`}
            >
              {w.label}
            </Link>
          ))}
        </div>
      }
    >
      {error ? (
        <p className="text-sm text-wx-danger">Couldn’t load: {error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-wx-mute">
          No scored forecasts in this window yet. Forecasts are scored automatically once their valid window
          closes (hourly cron), or via <span className="text-wx-fg">Rescore</span> on a forecast.
        </p>
      ) : (
        <div className="space-y-6">
          <p className="text-[13px] text-wx-mute">
            {rows.length} scored forecast{rows.length === 1 ? '' : 's'} · {verifiedCount} verified
            ({pct(verifiedCount / rows.length)}). Hazard calls scored against LSRs in the forecast area + window.
          </p>

          {/* Overall contingency */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-wx-fg">Overall hazard skill</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="POD (detection)" value={pct(pod(overall))} tone={toneFor('pod', pod(overall))} sub="hits ÷ (hits+misses)" />
              <Metric label="FAR (false alarm)" value={pct(far(overall))} tone={toneFor('far', far(overall))} sub="FA ÷ (hits+FA)" />
              <Metric label="CSI (overall)" value={pct(csi(overall))} tone={toneFor('csi', csi(overall))} sub="hits ÷ (H+M+FA)" />
              <Metric label="Hits" value={String(overall.hits)} tone="text-wx-ok" />
              <Metric label="Misses" value={String(overall.misses)} tone="text-yellow-400" />
              <Metric label="False alarms" value={String(overall.fa)} tone="text-wx-danger" />
            </div>
          </section>

          {/* Per-hazard */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-wx-fg">By hazard</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-wx-mute">
                    <th className="py-1.5 pr-3">Hazard</th>
                    <th className="px-2 text-right">Hits</th>
                    <th className="px-2 text-right">Miss</th>
                    <th className="px-2 text-right">FA</th>
                    <th className="px-2 text-right">POD</th>
                    <th className="px-2 text-right">FAR</th>
                    <th className="px-2 text-right">CSI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-wx-line">
                  {HAZARDS.map((h) => {
                    const c = byHazard[h];
                    const total = c.hits + c.misses + c.fa;
                    return (
                      <tr key={h} className={total === 0 ? 'text-wx-mute' : 'text-wx-fg'}>
                        <td className="py-1.5 pr-3 capitalize">{h}</td>
                        <td className="px-2 text-right font-mono text-wx-ok">{c.hits}</td>
                        <td className="px-2 text-right font-mono text-yellow-400">{c.misses}</td>
                        <td className="px-2 text-right font-mono text-wx-danger">{c.fa}</td>
                        <td className={`px-2 text-right font-mono ${toneFor('pod', pod(c))}`}>{pct(pod(c))}</td>
                        <td className={`px-2 text-right font-mono ${toneFor('far', far(c))}`}>{pct(far(c))}</td>
                        <td className={`px-2 text-right font-mono ${toneFor('csi', csi(c))}`}>{pct(csi(c))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Confidence reliability */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-wx-fg">Confidence reliability</h2>
            <p className="text-[11px] text-wx-mute">A calibrated forecaster verifies more often when they said “high.”</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {confOrder.filter((c) => byConf[c]).map((c) => {
                const b = byConf[c];
                const rate = b.verified / b.n;
                return (
                  <Metric
                    key={c}
                    label={c === '—' ? 'No confidence set' : `${c} confidence`}
                    value={pct(rate)}
                    tone={toneFor('pod', rate)}
                    sub={`${b.verified}/${b.n} verified`}
                  />
                );
              })}
            </div>
          </section>

          {/* Recent forecasts */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-wx-fg">Recent scored forecasts</h2>
            <ul className="divide-y divide-wx-line">
              {rows.slice(0, 25).map((r) => {
                const v = r.verification ?? {};
                const ok = v.hazard_match ?? (v.matched_hazards ?? []).length > 0;
                return (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                    <Link href={`/forecast/${r.id}`} className="min-w-0 flex-1 truncate text-sm text-wx-fg hover:text-wx-accent">
                      {r.title}
                    </Link>
                    <span className="shrink-0 text-[11px] text-wx-mute">
                      {new Date(r.valid_until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                      ok ? 'bg-wx-ok/15 text-wx-ok' : 'bg-wx-danger/15 text-wx-danger'
                    }`}>
                      {ok ? 'verified' : 'busted'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
    </DashShell>
  );
}
