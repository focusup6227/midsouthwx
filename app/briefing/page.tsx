import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

type SpcDay = { highest_label: string | null; issued_at: string | null; valid_from: string | null; valid_until: string | null };
type Afd = { wfo: string; product_id: string; issued_at: string; synopsis: string | null };
type Hwo = { id: string; event: string; headline: string | null; area_desc: string | null; effective: string | null; expires_at: string | null };
type Snapshot = {
  spc: Record<string, SpcDay>;
  afds: Afd[];
  hwos: Hwo[];
  warnings_count: number;
  watches_count: number;
  generated_at: string;
};

const SPC_TINT: Record<string, string> = {
  TSTM: 'text-emerald-300',
  MRGL: 'text-emerald-200',
  SLGT: 'text-amber-300',
  ENH:  'text-orange-300',
  MDT:  'text-red-300',
  HIGH: 'text-fuchsia-300',
};

const SPC_BG: Record<string, string> = {
  TSTM: 'bg-emerald-500/15 border-emerald-500/40',
  MRGL: 'bg-emerald-400/15 border-emerald-400/40',
  SLGT: 'bg-amber-400/15 border-amber-400/40',
  ENH:  'bg-orange-400/15 border-orange-400/40',
  MDT:  'bg-red-500/20 border-red-500/50',
  HIGH: 'bg-fuchsia-500/20 border-fuchsia-500/50',
};

export default async function BriefingPage() {
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('daily_briefing_snapshot');
  const snap = (data as Snapshot | null) ?? {
    spc: {}, afds: [], hwos: [],
    warnings_count: 0, watches_count: 0,
    generated_at: new Date().toISOString(),
  };

  return (
    <DashShell
      title="Daily briefing"
      width="wide"
      actions={
        <div className="flex gap-2">
          <Link href="/radar" className="btn-ghost text-sm">Radar</Link>
          <Link href="/nws" className="btn-ghost text-sm">NWS</Link>
        </div>
      }
    >
      <p className="text-wx-mute text-sm">
        Pre-event snapshot — SPC outlook, AFD synopses by WFO, and any active
        Hazardous Weather Outlooks. Refresh once an hour during the day; the
        actual data is polled every 5–30 min by the background workers.
      </p>

      <div className="text-[10px] text-wx-mute mt-1">
        Generated {new Date(snap.generated_at).toLocaleString()}.
      </div>

      {error ? (
        <div className="text-wx-danger text-sm mt-3">RPC error: {error.message}</div>
      ) : null}

      <h2 className="text-xs uppercase tracking-wider text-wx-mute font-semibold mt-5 mb-2">
        SPC convective outlook
      </h2>
      <div className="grid grid-cols-3 gap-2">
        {(['1', '2', '3'] as const).map((d) => {
          const day = snap.spc?.[d];
          const label = day?.highest_label ?? null;
          const bg = label ? SPC_BG[label] ?? 'bg-wx-line/30 border-wx-line' : 'bg-wx-line/20 border-wx-line';
          return (
            <div key={d} className={`card p-3 border ${bg}`}>
              <div className="text-[10px] uppercase tracking-wider text-wx-mute">Day {d}</div>
              <div className={`text-2xl font-semibold ${label ? SPC_TINT[label] ?? '' : 'text-wx-mute'}`}>
                {label ?? '—'}
              </div>
              {day?.issued_at ? (
                <div className="text-[10px] font-mono text-wx-mute mt-1">
                  issued {new Date(day.issued_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2 my-5">
        <div className="card p-3">
          <div className="text-[10px] uppercase tracking-wider text-wx-mute">Active warnings</div>
          <div className={`text-2xl font-semibold ${snap.warnings_count > 0 ? 'text-red-300' : 'text-wx-mute'}`}>
            {snap.warnings_count}
          </div>
        </div>
        <div className="card p-3">
          <div className="text-[10px] uppercase tracking-wider text-wx-mute">Active watches</div>
          <div className={`text-2xl font-semibold ${snap.watches_count > 0 ? 'text-amber-300' : 'text-wx-mute'}`}>
            {snap.watches_count}
          </div>
        </div>
      </div>

      {snap.hwos.length > 0 ? (
        <>
          <h2 className="text-xs uppercase tracking-wider text-wx-mute font-semibold mb-2">
            Hazardous weather outlooks
          </h2>
          <ul className="space-y-2 mb-5">
            {snap.hwos.map((h) => (
              <li key={h.id} className="card p-3">
                <div className="text-sm font-semibold">{h.headline ?? h.event}</div>
                {h.area_desc ? (
                  <div className="text-[11px] text-wx-mute mt-1 line-clamp-3">{h.area_desc}</div>
                ) : null}
                <div className="text-[10px] font-mono text-wx-mute mt-2">
                  {h.effective ? new Date(h.effective).toLocaleString() : '—'}
                  {h.expires_at ? ` — ${new Date(h.expires_at).toLocaleString()}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2 className="text-xs uppercase tracking-wider text-wx-mute font-semibold mb-2">
        Forecast discussions (last 24h)
      </h2>
      {snap.afds.length === 0 ? (
        <p className="text-wx-mute text-sm">No AFDs in the last 24h.</p>
      ) : (
        <ul className="space-y-2">
          {snap.afds.map((a) => (
            <li key={a.product_id} className="card p-3">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <div className="text-sm font-semibold">{a.wfo}</div>
                <div className="text-[10px] font-mono text-wx-mute">
                  {new Date(a.issued_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
              {a.synopsis ? (
                <p className="text-[11.5px] text-wx-fg/85 whitespace-pre-wrap line-clamp-6">
                  {a.synopsis}
                </p>
              ) : (
                <div className="text-[11px] text-wx-mute italic">No synopsis available.</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </DashShell>
  );
}
