import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

type Health = {
  function_name: string;
  last_fired_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  runs_24h: number;
  failures_24h: number;
  avg_duration_ms: number | null;
};

type Cron = { jobname: string; schedule: string; active: boolean };

type QueueRow = { status: string; count: number; oldest_at: string | null };

// Expected cadence per function — used to flag stale runs even if the cron
// schedule isn't installed. Keep in sync with the migration's pg_cron rows.
const EXPECTED_CADENCE_MIN: Record<string, number> = {
  'nws-poll': 1,
  'nws-dispatcher': 1,
  'scheduled-dispatcher': 1,
  'telegram-send-worker': 1,
  'event-recap': 5,
  'health-monitor': 5,
  'lsr-poll': 5,
  'spc-poll': 30,
  'afd-poll': 30,
  'couplet-poll': 1,
};

function fmtAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function statusFor(h: Health, expectedMin?: number): { label: string; cls: string } {
  if (!h.last_fired_at) return { label: 'NO DATA', cls: 'border-wx-line text-wx-mute' };
  const ageMin = (Date.now() - new Date(h.last_fired_at).getTime()) / 60_000;
  if (expectedMin && ageMin > expectedMin * 3) {
    return { label: 'STALE', cls: 'border-red-500/60 text-red-300 bg-red-500/10' };
  }
  if (h.last_failure_at && h.last_success_at) {
    const failedAfterSuccess = new Date(h.last_failure_at).getTime() > new Date(h.last_success_at).getTime();
    if (failedAfterSuccess) {
      return { label: 'FAILING', cls: 'border-red-500/60 text-red-300 bg-red-500/10' };
    }
  } else if (h.last_failure_at && !h.last_success_at) {
    return { label: 'FAILING', cls: 'border-red-500/60 text-red-300 bg-red-500/10' };
  }
  if (h.failures_24h > 0) {
    return { label: 'DEGRADED', cls: 'border-amber-500/60 text-amber-300 bg-amber-500/10' };
  }
  return { label: 'OK', cls: 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10' };
}

export default async function HealthPage() {
  const supa = supabaseServer();

  const [healthRes, cronRes, queueRes] = await Promise.all([
    supa.rpc('function_health'),
    supa.rpc('cron_jobs_listing'),
    supa.rpc('outbound_queue_depth'),
  ]);

  const healthRows: Health[] = (healthRes.data ?? []) as Health[];
  const cronRows: Cron[] = (cronRes.data ?? []) as Cron[];
  const queueRows: QueueRow[] = (queueRes.data ?? []) as QueueRow[];

  const cronByJob = new Map(cronRows.map((c) => [c.jobname, c]));

  // Union of expected + observed function names so we surface "never ran" too.
  const knownNames = new Set<string>(Object.keys(EXPECTED_CADENCE_MIN));
  for (const r of healthRows) knownNames.add(r.function_name);
  const rows = Array.from(knownNames).sort().map((name) => {
    const r = healthRows.find((x) => x.function_name === name) ?? {
      function_name: name,
      last_fired_at: null,
      last_success_at: null,
      last_failure_at: null,
      last_error: null,
      runs_24h: 0,
      failures_24h: 0,
      avg_duration_ms: null,
    };
    return r as Health;
  });

  const pending = queueRows.find((q) => q.status === 'pending');
  const failed = queueRows.find((q) => q.status === 'failed');
  const totalQueued = queueRows.reduce((s, q) => s + (q.count ?? 0), 0);

  return (
    <DashShell title="Health" width="wide">
      <p className="text-sm text-wx-mute">
        Edge function run history (last 24h) and outbound queue state. Each
        function writes one row via <code className="text-xs">log_function_run</code> at the
        end of every invocation. Schedules are read live from{' '}
        <code className="text-xs">cron.job</code>.
      </p>

      <section className="grid sm:grid-cols-3 gap-3">
        <QueueCard
          label="Outbound queue · pending"
          count={pending?.count ?? 0}
          oldest_at={pending?.oldest_at ?? null}
          tone={(pending?.count ?? 0) > 200 ? 'warn' : 'ok'}
        />
        <QueueCard
          label="Outbound queue · failed"
          count={failed?.count ?? 0}
          oldest_at={failed?.oldest_at ?? null}
          tone={(failed?.count ?? 0) > 0 ? 'warn' : 'ok'}
        />
        <QueueCard
          label="Outbound queue · total"
          count={totalQueued}
          oldest_at={null}
          tone="info"
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-wx-mute uppercase tracking-wider">Edge functions</h2>
        <div className="overflow-x-auto card">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-wx-mute border-b border-wx-line text-[11px]">
                <th className="px-4 py-2">Function</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Schedule</th>
                <th className="px-4 py-2">Last fired</th>
                <th className="px-4 py-2">Last success</th>
                <th className="px-4 py-2">24h runs</th>
                <th className="px-4 py-2">24h fail</th>
                <th className="px-4 py-2">Avg ms</th>
                <th className="px-4 py-2">Last error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-wx-line">
              {rows.map((r) => {
                const cron = cronByJob.get(r.function_name);
                const cadence = EXPECTED_CADENCE_MIN[r.function_name];
                const status = statusFor(r, cadence);
                return (
                  <tr key={r.function_name}>
                    <td className="px-4 py-2 font-mono text-xs">{r.function_name}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-bold rounded border ${status.cls}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-wx-mute">
                      {cron
                        ? `${cron.schedule}${cron.active ? '' : ' · OFF'}`
                        : cadence
                          ? `expected ~${cadence}m`
                          : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs">{fmtAgo(r.last_fired_at)}</td>
                    <td className="px-4 py-2 text-xs">{fmtAgo(r.last_success_at)}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.runs_24h}</td>
                    <td className={`px-4 py-2 font-mono text-xs ${r.failures_24h > 0 ? 'text-red-300' : ''}`}>
                      {r.failures_24h}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-wx-mute">{r.avg_duration_ms ?? '—'}</td>
                    <td className="px-4 py-2 text-[11px] text-red-300/90 max-w-[280px] truncate" title={r.last_error ?? ''}>
                      {r.last_error ?? ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-wx-mute uppercase tracking-wider">Other cron jobs</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-wx-mute border-b border-wx-line text-[11px]">
                <th className="px-4 py-2">Job</th>
                <th className="px-4 py-2">Schedule</th>
                <th className="px-4 py-2">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-wx-line">
              {cronRows
                .filter((c) => !knownNames.has(c.jobname))
                .map((c) => (
                  <tr key={c.jobname}>
                    <td className="px-4 py-2 font-mono text-xs">{c.jobname}</td>
                    <td className="px-4 py-2 font-mono text-[11px] text-wx-mute">{c.schedule}</td>
                    <td className="px-4 py-2 text-xs">{c.active ? 'yes' : <span className="text-red-300">no</span>}</td>
                  </tr>
                ))}
              {cronRows.filter((c) => !knownNames.has(c.jobname)).length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-xs text-wx-mute">
                    No other cron jobs registered.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </DashShell>
  );
}

function QueueCard({
  label,
  count,
  oldest_at,
  tone,
}: {
  label: string;
  count: number;
  oldest_at: string | null;
  tone: 'ok' | 'warn' | 'info';
}) {
  const cls =
    tone === 'warn'
      ? 'border-amber-500/40 bg-amber-500/10'
      : tone === 'ok'
        ? 'border-emerald-500/30 bg-emerald-500/5'
        : 'border-wx-line';
  return (
    <div className={`card p-4 border ${cls}`}>
      <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">{label}</div>
      <div className="mt-1 text-2xl font-extrabold">{count}</div>
      {oldest_at ? (
        <div className="text-[11px] text-wx-mute mt-0.5">oldest {fmtAgo(oldest_at)}</div>
      ) : null}
    </div>
  );
}
