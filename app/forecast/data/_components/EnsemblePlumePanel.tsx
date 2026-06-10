'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, RefreshCw } from 'lucide-react';
import { MIDSOUTH_POINTS, type ForecastPoint } from '@/lib/forecast/points';
import { useSharedForecastPoint } from '@/lib/forecast/use-shared-point';

type EnsembleData = {
  time: string[];
  series: Record<string, number[][]>; // var -> members -> series
  units?: Record<string, string>;
  members: number;
  error?: string;
};

const VARS = [
  { key: 'temperature_2m', label: 'Temperature', unit: '°F' },
  { key: 'dewpoint_2m', label: 'Dewpoint', unit: '°F' },
  { key: 'precipitation', label: 'Precip (3h)', unit: 'in' },
  { key: 'wind_speed_10m', label: 'Wind', unit: 'kt' },
];

const C_MEAN = '#fbbf24';
const C_MEMBER = '#64748b';
const C_BAND = '#3b82f6';
const C_GRID = '#1f2937';
const C_MUTE = '#64748b';

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

function Plume({ members, time, unit }: { members: number[][]; time: string[]; unit: string }) {
  const W = 900, H = 280, padL = 36, padR = 12, padT = 12, padB = 28;
  const n = time.length;

  const { lo, hi, meanS, minS, maxS } = useMemo(() => {
    const meanS: number[] = [], minS: number[] = [], maxS: number[] = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const col = members.map((m) => m[i]).filter((x) => Number.isFinite(x));
      if (!col.length) { meanS.push(NaN); minS.push(NaN); maxS.push(NaN); continue; }
      const mn = Math.min(...col), mx = Math.max(...col);
      const mean = col.reduce((a, b) => a + b, 0) / col.length;
      meanS.push(mean); minS.push(mn); maxS.push(mx);
      lo = Math.min(lo, mn); hi = Math.max(hi, mx);
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = Math.max(1, (hi - lo) * 0.1);
    return { lo: lo - pad, hi: hi + pad, meanS, minS, maxS };
  }, [members, n]);

  if (n < 2) return <p className="text-[11px] text-wx-mute">No data.</p>;

  const x = (i: number) => padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v: number) => padT + (H - padT - padB) - ((v - lo) / (hi - lo || 1)) * (H - padT - padB);

  const path = (s: number[]) => {
    let d = '', started = false;
    s.forEach((v, i) => {
      if (!Number.isFinite(v)) { started = false; return; }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      started = true;
    });
    return d;
  };

  // Spread band polygon: max forward, min back.
  let band = '';
  maxS.forEach((v, i) => { if (Number.isFinite(v)) band += `${band ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; });
  for (let i = n - 1; i >= 0; i--) { if (Number.isFinite(minS[i])) band += `L${x(i).toFixed(1)} ${y(minS[i]).toFixed(1)} `; }
  band += 'Z';

  const ticks: number[] = [];
  const step = Math.max(1, Math.round((hi - lo) / 4));
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[560px]" role="img" aria-label="Ensemble plume">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={C_GRID} strokeWidth={1} />
          <text x={padL - 4} y={y(v) + 3} textAnchor="end" fontSize={9} fill={C_MUTE}>{v}</text>
        </g>
      ))}
      <path d={band} fill={C_BAND} opacity={0.16} />
      {members.map((m, i) => (
        <path key={i} d={path(m)} fill="none" stroke={C_MEMBER} strokeWidth={0.5} opacity={0.35} />
      ))}
      <path d={path(meanS)} fill="none" stroke={C_MEAN} strokeWidth={2} />
      {/* day axis */}
      {time.map((t, i) => {
        const prev = i > 0 ? fmtDay(time[i - 1]) : null;
        const day = fmtDay(t);
        if (i !== 0 && day === prev) return null;
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={padT} y2={H - padB} stroke={C_GRID} strokeWidth={0.5} opacity={0.5} />
            <text x={x(i)} y={H - padB + 14} textAnchor="middle" fontSize={9} fill={C_MUTE}>{day}</text>
          </g>
        );
      })}
      <text x={W - padR} y={padT + 9} textAnchor="end" fontSize={9} fill={C_MUTE}>{unit}</text>
    </svg>
  );
}

export default function EnsemblePlumePanel() {
  const [pt, setPt] = useSharedForecastPoint();
  const [varKey, setVarKey] = useState('temperature_2m');
  const [data, setData] = useState<EnsembleData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/forecast/ensemble?lat=${pt.lat}&lon=${pt.lon}&days=7`);
      const d: EnsembleData = await r.json();
      if (id !== reqId.current) return;
      if (d.error) setErr(d.error); else setData(d);
    } catch (e: any) {
      if (id === reqId.current) setErr(e?.message ?? 'fetch_error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [pt.lat, pt.lon]);

  useEffect(() => { void load(); }, [load]);

  const v = VARS.find((x) => x.key === varKey)!;
  const members = useMemo(() => data?.series?.[varKey] ?? [], [data, varKey]);

  // Confidence read: spread at ~day 3 relative to the variable's range.
  const confidence = useMemo(() => {
    if (!members.length || !data) return null;
    const i = Math.min(data.time.length - 1, Math.floor(data.time.length / 2));
    const col = members.map((m) => m[i]).filter((x) => Number.isFinite(x));
    if (col.length < 3) return null;
    const spread = Math.max(...col) - Math.min(...col);
    if (varKey === 'precipitation') {
      return spread < 0.1 ? 'High agreement' : spread < 0.5 ? 'Moderate spread' : 'Low confidence (wet/dry split)';
    }
    // temp/dewp/wind in same-ish units
    return spread < 6 ? 'High agreement' : spread < 14 ? 'Moderate spread' : 'Low confidence';
  }, [members, data, varKey]);

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">Ensemble plumes (GEFS)</h2>
          <p className="text-[11px] text-wx-mute">
            31 members · 7 days · mean + spread
            {confidence ? ` · ${confidence}` : ''}
          </p>
        </div>
        <button type="button" onClick={() => load()}
          className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {VARS.map((x) => (
            <button key={x.key} type="button" onClick={() => setVarKey(x.key)}
              className={`rounded-md border px-2 py-1 text-[11px] ${
                varKey === x.key ? 'border-wx-accent text-wx-accent' : 'border-wx-line bg-wx-ink text-wx-mute hover:text-wx-fg hover:border-wx-accent'
              }`}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          {MIDSOUTH_POINTS.slice(0, 6).map((p) => (
            <button key={p.key} type="button" onClick={() => setPt(p)}
              className={`rounded-md px-2 py-1 text-[11px] ${
                p.key === pt.key ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent' : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'
              }`}>
              <MapPin size={9} className="mr-1 inline" />{p.city}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-wx-line bg-wx-ink p-3">
        <div className="mb-1 flex items-center gap-3 text-[10px] text-wx-mute">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: C_MEAN }} /> mean</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2" style={{ background: C_BAND, opacity: 0.3 }} /> member spread</span>
          <span className="font-semibold text-wx-fg">{pt.city} · {v.label}</span>
        </div>
        {err && !data ? (
          <p className="py-8 text-center text-[12px] text-wx-mute">Couldn’t load ensemble ({err}).</p>
        ) : !data ? (
          <p className="py-8 text-center text-[12px] text-wx-mute">Loading…</p>
        ) : (
          <div className="overflow-x-auto"><Plume members={members} time={data.time} unit={v.unit} /></div>
        )}
      </div>
    </section>
  );
}
