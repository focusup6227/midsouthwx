import Link from 'next/link';
import DashShell from '@/components/DashShell';
import { supabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type ForecastRow = {
  id: string;
  title: string;
  hazards: string[] | null;
  confidence: string | null;
  status: string;
  valid_from: string;
  valid_until: string;
  created_at: string;
};

function fmt(dt: string): string {
  try {
    return new Date(dt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return dt;
  }
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'closed' ? 'bg-wx-ink text-wx-mute border-wx-line' :
    status === 'issued' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-700' :
    status === 'ai_draft' ? 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-700' :
    'bg-amber-500/10 text-amber-300 border-amber-700';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wider ${tone}`}>
      {status}
    </span>
  );
}

export default async function ForecastListPage() {
  const supa = supabaseServer();
  const { data, error } = await supa
    .from('forecasts')
    .select('id, title, hazards, confidence, status, valid_from, valid_until, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  const rows = (data ?? []) as ForecastRow[];

  return (
    <DashShell
      title="Forecasts"
      width="wide"
      actions={
        <div className="flex gap-2">
          <Link
            href="/forecast/data"
            className="inline-flex items-center gap-2 rounded-lg border border-wx-line bg-wx-ink px-3 py-1.5 text-sm font-semibold text-wx-fg hover:border-wx-accent hover:text-wx-accent"
          >
            Data viewers
          </Link>
          <Link
            href="/forecast/new"
            className="inline-flex items-center gap-2 rounded-lg bg-wx-accent px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-300"
          >
            New forecast
          </Link>
        </div>
      }
    >
      {error ? (
        <div className="rounded-lg border border-red-500 bg-red-500/10 p-3 text-sm text-red-200">
          Failed to load forecasts: {error.message}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-wx-line bg-wx-card p-8 text-center text-sm text-wx-mute">
          No forecasts yet. <Link href="/forecast/new" className="text-wx-accent">Draft one</Link> — or open <Link href="/radar" className="text-wx-accent">/radar</Link>, draw an area, and click <span className="text-wx-fg">Forecast this area</span>.
        </div>
      ) : (
        <ul className="divide-y divide-wx-line rounded-lg border border-wx-line bg-wx-card">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/forecast/${r.id}`}
                className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-wx-ink"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-wx-fg">{r.title}</span>
                    <StatusPill status={r.status} />
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-wx-mute">
                    {fmt(r.valid_from)} → {fmt(r.valid_until)}
                    {r.confidence ? <> · confidence {r.confidence}</> : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(r.hazards ?? []).map((h) => (
                    <span key={h} className="rounded border border-wx-line bg-wx-ink px-1.5 py-[1px] text-[10px] uppercase tracking-wider text-wx-mute">
                      {h}
                    </span>
                  ))}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashShell>
  );
}
