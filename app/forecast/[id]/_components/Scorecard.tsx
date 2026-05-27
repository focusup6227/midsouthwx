import { RefreshCw } from 'lucide-react';
import { rescoreForecast } from '../../actions';

// Shape returned by the score_forecast SQL function (see
// supabase/migrations/20260609000001_forecast_verification.sql). All keys
// are optional here because the column nullable until the first scoring
// pass; component handles partial / null gracefully.
type Verification = {
  scored_at?: string;
  window?: { from?: string; until?: string };
  warnings_in_area?: number;
  warnings_by_event?: Record<string, number>;
  lsrs_in_area?: number;
  lsrs_by_hazard?: Record<string, number>;
  matched_hazards?: string[];
  missed_hazards?: string[];
  hazard_match?: boolean;
};

type Props = {
  forecastId: string;
  verification: Verification | null;
  validUntil: string;
};

function fmtTime(dt?: string): string {
  if (!dt) return '—';
  try { return new Date(dt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return dt; }
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-wx-line bg-wx-ink p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">{label}</div>
      <div className="mt-0.5 text-xl font-bold leading-none text-wx-fg">{value}</div>
    </div>
  );
}

function PillRow({ items, tone }: { items: string[]; tone: 'good' | 'bad' | 'neutral' }) {
  if (items.length === 0) return <span className="text-[11px] text-wx-mute">—</span>;
  const cls =
    tone === 'good' ? 'border-emerald-700 bg-emerald-500/10 text-emerald-300' :
    tone === 'bad'  ? 'border-amber-700 bg-amber-500/10 text-amber-300' :
                      'border-wx-line bg-wx-ink text-wx-mute';
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((h) => (
        <span key={h} className={`rounded border px-1.5 py-[1px] text-[10px] uppercase tracking-wider ${cls}`}>
          {h}
        </span>
      ))}
    </div>
  );
}

export default function Scorecard({ forecastId, verification, validUntil }: Props) {
  const v = verification ?? {};
  const hasData = verification !== null;
  const windowClosed = new Date(validUntil) <= new Date();

  // Server action with id pre-bound; the inline form uses it directly so we
  // don't need a client wrapper just for the rescore button.
  const rescoreAction = rescoreForecast.bind(null, forecastId);

  return (
    <div className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-wx-mute">Verification</div>
        <form action={rescoreAction}>
          <button
            type="submit"
            className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
            title={windowClosed ? 'Recompute against current data' : 'Window has not closed yet — preview scoring'}
          >
            <RefreshCw size={11} /> {hasData ? 'Rescore' : 'Score now'}
          </button>
        </form>
      </div>

      {!hasData ? (
        <div className="text-[11.5px] text-wx-mute">
          Not scored yet. The hourly cron picks this up once the window closes ({fmtTime(validUntil)}), or click <span className="text-wx-fg">Score now</span> for a preview.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Warnings in area" value={v.warnings_in_area ?? 0} />
            <Stat label="LSRs in area" value={v.lsrs_in_area ?? 0} />
          </div>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Matched hazards</div>
            <div className="mt-1">
              <PillRow items={v.matched_hazards ?? []} tone="good" />
            </div>
          </div>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Missed hazards (occurred, not forecast)</div>
            <div className="mt-1">
              <PillRow items={v.missed_hazards ?? []} tone="bad" />
            </div>
          </div>

          {Object.keys(v.warnings_by_event ?? {}).length > 0 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Warnings by event</div>
              <ul className="mt-1 space-y-0.5 text-[11.5px]">
                {Object.entries(v.warnings_by_event ?? {}).map(([k, c]) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span className="text-wx-fg">{k}</span>
                    <span className="text-wx-mute font-mono">{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {Object.keys(v.lsrs_by_hazard ?? {}).length > 0 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">LSRs by hazard</div>
              <ul className="mt-1 space-y-0.5 text-[11.5px]">
                {Object.entries(v.lsrs_by_hazard ?? {}).map(([k, c]) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span className="text-wx-fg">{k}</span>
                    <span className="text-wx-mute font-mono">{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="border-t border-wx-line pt-2 text-[10.5px] text-wx-mute">
            Scored {fmtTime(v.scored_at)} · window {fmtTime(v.window?.from)} → {fmtTime(v.window?.until)}
          </div>
        </>
      )}
    </div>
  );
}
