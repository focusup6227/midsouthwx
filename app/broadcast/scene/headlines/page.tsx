'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SceneShell } from '../_shared';
import { useBroadcastState, RISK_COLOR } from '../../overlay/useBroadcastState';

const RISK_NAME: Record<string, string> = {
  TSTM: 'Thunderstorms', MRGL: 'Marginal', SLGT: 'Slight', ENH: 'Enhanced', MDT: 'Moderate', HIGH: 'High',
};

function alertTone(event: string): string {
  const e = event.toLowerCase();
  if (e.includes('tornado') && e.includes('warning')) return '#ef4444';
  if (e.includes('warning')) return '#f97316';
  if (e.includes('watch')) return '#eab308';
  return '#38bdf8';
}

// Live full-screen briefing board: SPC Day 1-3 risk, warning/watch counts, and
// the active-alert list. A great "talk over it" scene or screen-record target.
//   ?brand=MID-SOUTH WX&accent=%23fbbf24
function Headlines() {
  const q = useSearchParams();
  const brand = q.get('brand') ?? 'MID-SOUTH WX';
  const accent = q.get('accent') ?? '#fbbf24';
  const state = useBroadcastState(30000);
  const days = state?.spc_days ?? [1, 2, 3].map((d) => ({ day: d, label: null as string | null }));
  const items = state?.items ?? [];
  const rotation = state?.rotation_tracks ?? [];

  return (
    <SceneShell brand={brand} accent={accent} showAlerts={false}>
      <div className="w-full max-w-[80vw]">
        <div className="text-left text-[2.2vh] font-bold uppercase tracking-[0.4em] text-white/50">Weather Headlines</div>

        {/* SPC Day 1-3 */}
        <div className="mt-[2vh] grid grid-cols-3 gap-[2vh]">
          {days.map((d) => {
            const color = d.label ? RISK_COLOR[d.label] ?? '#64748b' : '#334155';
            return (
              <div key={d.day} className="rounded-2xl border border-white/10 bg-black/40 p-[2vh]" style={{ borderTopColor: color, borderTopWidth: '0.6vh' }}>
                <div className="text-[1.8vh] font-semibold uppercase tracking-widest text-white/45">Day {d.day}</div>
                <div className="mt-[0.6vh] text-[4.2vh] font-extrabold leading-none" style={{ color }}>
                  {d.label ? RISK_NAME[d.label] ?? d.label : '—'}
                </div>
              </div>
            );
          })}
        </div>

        {/* Counts */}
        <div className="mt-[2vh] flex gap-[2vh]">
          <div className="flex-1 rounded-2xl bg-red-600/15 border border-red-500/40 p-[1.8vh]">
            <div className="text-[1.6vh] uppercase tracking-widest text-red-200/70">Active warnings</div>
            <div className="text-[5vh] font-extrabold leading-none text-red-300">{state?.warnings_count ?? 0}</div>
          </div>
          <div className="flex-1 rounded-2xl bg-amber-500/15 border border-amber-400/40 p-[1.8vh]">
            <div className="text-[1.6vh] uppercase tracking-widest text-amber-200/70">Active watches</div>
            <div className="text-[5vh] font-extrabold leading-none text-amber-300">{state?.watches_count ?? 0}</div>
          </div>
        </div>

        {/* Live rotation tracks — only rendered when the couplet detector has
            something, so quiet days keep the board clean. */}
        {rotation.length > 0 ? (
          <div className="mt-[2vh] rounded-2xl border border-fuchsia-500/40 bg-fuchsia-600/10 p-[1.8vh] text-left">
            <div className="text-[1.6vh] uppercase tracking-widest text-fuchsia-200/70">Radar-indicated rotation</div>
            <div className="mt-[0.8vh] flex flex-col gap-[0.8vh]">
              {rotation.slice(0, 4).map((r) => (
                <div key={r.track_id} className="flex items-baseline gap-[1.4vh]">
                  <span className="text-[2.3vh] font-extrabold text-fuchsia-300">{r.track_id}</span>
                  <span className="text-[2vh] font-semibold text-white/85">{r.shear_kt} kt shear</span>
                  <span className="text-[1.7vh] text-white/50">
                    {r.volume_count > 1 ? `persistent · ${r.volume_count} scans` : 'new this scan'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Alert list */}
        <div className="mt-[2vh] rounded-2xl border border-white/10 bg-black/30 p-[2vh] text-left">
          {items.length === 0 ? (
            <div className="text-[2.4vh] font-medium text-white/55">No active warnings or watches — conditions quiet across the Mid-South.</div>
          ) : (
            <div className="flex flex-col gap-[1.2vh]">
              {items.slice(0, 6).map((it, i) => (
                <div key={i} className="flex items-center gap-[1.4vh]">
                  <span className="inline-block h-[1.6vh] w-[1.6vh] shrink-0 rounded-full" style={{ background: alertTone(it.event) }} />
                  <span className="text-[2.3vh] font-bold">{it.event}</span>
                  {it.area ? <span className="truncate text-[2vh] text-white/55">— {it.area}</span> : null}
                </div>
              ))}
              {items.length > 6 ? (
                <div className="text-[1.8vh] text-white/40">+{items.length - 6} more active…</div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </SceneShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Headlines />
    </Suspense>
  );
}
