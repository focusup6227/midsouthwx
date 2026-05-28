import Link from 'next/link';
import DashShell from '@/components/DashShell';
import { supabaseServer } from '@/lib/supabase/server';
import TemplateRowActions from './_components/TemplateRowActions';

export const dynamic = 'force-dynamic';

type Row = {
  id: string;
  name: string;
  hazards: string[] | null;
  confidence: string | null;
  cadence: 'daily' | 'weekly';
  hour_of_day: number;
  window_hours: number;
  enabled: boolean;
  last_fired_at: string | null;
  next_run_at: string;
  created_at: string;
};

function fmt(dt: string | null): string {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return dt;
  }
}

export default async function ForecastTemplatesPage() {
  const supa = supabaseServer();
  const { data } = await supa
    .from('forecast_templates')
    .select('id, name, hazards, confidence, cadence, hour_of_day, window_hours, enabled, last_fired_at, next_run_at, created_at')
    .order('enabled', { ascending: false })
    .order('next_run_at', { ascending: true });
  const rows = (data ?? []) as Row[];

  return (
    <DashShell
      title="Forecast templates"
      width="wide"
      backHref="/forecast"
      actions={<Link href="/forecast" className="btn-ghost text-sm">All forecasts</Link>}
    >
      <p className="text-wx-mute text-sm">
        Each template fires on its cadence and auto-creates a draft forecast
        populated with the freshest SPC + AFD + LSR snapshot for the saved
        area. Open the draft, optionally tap <em>AI draft</em>, edit, then
        broadcast. Create a template from any existing forecast via the
        &quot;Save as template&quot; button on its detail page.
      </p>

      {rows.length === 0 ? (
        <p className="text-wx-mute text-sm mt-5">
          No templates yet. Visit a forecast and tap <strong>Save as template</strong> to seed one from the area you already drew.
        </p>
      ) : (
        <ul className="divide-y divide-wx-line card mt-4">
          {rows.map((r) => (
            <li key={r.id} className="p-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium truncate">{r.name}</span>
                  <span
                    className={
                      'rounded-full border px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wider ' +
                      (r.enabled
                        ? 'border-emerald-700 bg-emerald-500/10 text-emerald-300'
                        : 'border-wx-line bg-wx-ink text-wx-mute')
                    }
                  >
                    {r.enabled ? 'enabled' : 'paused'}
                  </span>
                </div>
                <div className="text-xs text-wx-mute flex flex-wrap gap-x-3 gap-y-1">
                  <span>{r.cadence} @ {String(r.hour_of_day).padStart(2, '0')}:00 UTC</span>
                  <span>{r.window_hours}h window</span>
                  <span>hazards: {(r.hazards ?? []).join(', ') || '—'}</span>
                  {r.confidence ? <span>conf: {r.confidence}</span> : null}
                </div>
                <div className="text-[11px] font-mono text-wx-mute">
                  next: {fmt(r.next_run_at)} · last: {fmt(r.last_fired_at)}
                </div>
              </div>
              <TemplateRowActions id={r.id} enabled={r.enabled} />
            </li>
          ))}
        </ul>
      )}
    </DashShell>
  );
}
