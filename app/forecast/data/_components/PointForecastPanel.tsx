'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, RefreshCw, Wind } from 'lucide-react';
import {
  MIDSOUTH_POINTS,
  type HourPoint,
  type PointForecast,
} from '@/lib/forecast/points';
import { useSharedForecastPoint } from '@/lib/forecast/use-shared-point';

// Colors picked to read on the wx-card dark background; kept as literals
// because Tailwind tokens can't drive SVG stroke/fill.
const C_TEMP = '#fbbf24'; // amber (matches wx-accent)
const C_DEWP = '#38bdf8'; // sky blue
const C_POP = '#3b82f6';  // blue
const C_GRID = '#1f2937'; // wx-line
const C_MUTE = '#64748b'; // wx-mute

function fmtHour(iso: string, tz: string | null): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: tz ?? undefined })
    .replace(' ', '')
    .toLowerCase();
}
function fmtDay(iso: string, tz: string | null): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: tz ?? undefined });
}
function fmtUpdated(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Meteogram({ hourly, tz }: { hourly: HourPoint[]; tz: string | null }) {
  const W = 900, H = 280;
  const padL = 34, padR = 12, padT = 14;
  const tempH = 140;             // temp/dewpoint plot height
  const popTop = padT + tempH + 18, popH = 46;
  const windY = popTop + popH + 26;
  const axisY = windY + 22;

  const n = hourly.length;
  const { min, max } = useMemo(() => {
    const vals = hourly.flatMap((h) => [h.tempF, h.dewpF]).filter((v): v is number => v != null);
    if (!vals.length) return { min: 0, max: 100 };
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max(4, (hi - lo) * 0.15);
    return { min: Math.floor(lo - pad), max: Math.ceil(hi + pad) };
  }, [hourly]);

  if (n < 2) return <p className="text-[11px] text-wx-mute">Not enough data to plot.</p>;

  const x = (i: number) => padL + (i * (W - padL - padR)) / (n - 1);
  const yTemp = (v: number) => padT + tempH - ((v - min) / (max - min || 1)) * tempH;
  const yPop = (v: number) => popTop + popH - (v / 100) * popH;

  const line = (key: keyof HourPoint, color: string) => {
    let d = '';
    let started = false;
    hourly.forEach((h, i) => {
      const v = h[key] as number | null;
      if (v == null) { started = false; return; }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)} ${yTemp(v).toFixed(1)} `;
      started = true;
    });
    return <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />;
  };

  // Temp axis ticks (~4 lines).
  const ticks: number[] = [];
  const step = Math.max(2, Math.round((max - min) / 4 / 2) * 2);
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);

  // Bar width for PoP.
  const bw = Math.max(2, (W - padL - padR) / n - 1.5);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[560px]" role="img" aria-label="Hourly forecast meteogram">
      {/* temp gridlines + axis labels */}
      {ticks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={yTemp(v)} y2={yTemp(v)} stroke={C_GRID} strokeWidth={1} />
          <text x={padL - 5} y={yTemp(v) + 3} textAnchor="end" fontSize={9} fill={C_MUTE}>{v}°</text>
        </g>
      ))}

      {/* PoP bars */}
      <text x={padL - 5} y={popTop + 8} textAnchor="end" fontSize={8} fill={C_MUTE}>PoP</text>
      <line x1={padL} x2={W - padR} y1={popTop + popH} y2={popTop + popH} stroke={C_GRID} strokeWidth={1} />
      {hourly.map((h, i) =>
        h.pop != null && h.pop > 0 ? (
          <rect
            key={i}
            x={x(i) - bw / 2}
            y={yPop(h.pop)}
            width={bw}
            height={popTop + popH - yPop(h.pop)}
            fill={C_POP}
            opacity={0.55}
          />
        ) : null,
      )}

      {/* dewpoint then temp lines (temp on top) */}
      {line('dewpF', C_DEWP)}
      {line('tempF', C_TEMP)}

      {/* wind arrows every 3h (arrow points the way wind blows TO) */}
      {hourly.map((h, i) =>
        i % 3 === 0 && h.windDeg != null ? (
          <g key={i} transform={`translate(${x(i)} ${windY})`}>
            <g transform={`rotate(${(h.windDeg + 180) % 360})`}>
              <line x1={0} y1={-6} x2={0} y2={6} stroke={C_MUTE} strokeWidth={1.3} />
              <path d="M0 6 L-2.5 1 L2.5 1 Z" fill={C_MUTE} />
            </g>
            {h.windMph != null ? (
              <text x={0} y={16} textAnchor="middle" fontSize={8} fill={C_MUTE}>{h.windMph}</text>
            ) : null}
          </g>
        ) : null,
      )}
      <text x={padL - 5} y={windY + 3} textAnchor="end" fontSize={8} fill={C_MUTE}>
        <tspan>wnd</tspan>
      </text>

      {/* time axis: hour every 3h, weekday at midnight/boundary */}
      {hourly.map((h, i) => {
        if (i % 3 !== 0) return null;
        const prevDay = i > 0 ? fmtDay(hourly[i - 1].time, tz) : null;
        const day = fmtDay(h.time, tz);
        const showDay = i === 0 || day !== prevDay;
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={padT} y2={popTop + popH} stroke={C_GRID} strokeWidth={0.5} opacity={0.5} />
            <text x={x(i)} y={axisY} textAnchor="middle" fontSize={8.5} fill={C_MUTE}>{fmtHour(h.time, tz)}</text>
            {showDay ? (
              <text x={x(i)} y={axisY + 11} textAnchor="middle" fontSize={8.5} fill="#94a3b8" fontWeight={600}>{day}</text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export default function PointForecastPanel() {
  const [pt, setPt] = useSharedForecastPoint();
  const [latlon, setLatLon] = useState('');
  const [data, setData] = useState<PointForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);

  async function load(lat: number, lon: number) {
    const id = ++reqId.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/forecast/point?lat=${lat}&lon=${lon}&hours=48`);
      const d: PointForecast = await res.json();
      if (id !== reqId.current) return; // stale response, ignore
      if (d.error) setErr(d.error);
      setData(d);
    } catch (e: any) {
      if (id === reqId.current) setErr(e?.message ?? 'fetch_error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(pt.lat, pt.lon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pt.key]);

  function submitLatLon(e: React.FormEvent) {
    e.preventDefault();
    const m = latlon.match(/(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/);
    if (!m) { setErr('Enter as "lat, lon"'); return; }
    const lat = Number(m[1]), lon = Number(m[2]);
    setPt({ key: `custom:${lat},${lon}`, city: `${lat.toFixed(2)}, ${lon.toFixed(2)}`, state: '', lat, lon });
  }

  const loc = data?.location;
  const obs = data?.obs;

  const obsLine = useMemo(() => {
    if (!obs) return null;
    const bits: string[] = [];
    if (obs.tempF != null) bits.push(`${Math.round(obs.tempF)}°F`);
    if (obs.dewpF != null) bits.push(`dp ${Math.round(obs.dewpF)}°`);
    if (obs.windKt != null) bits.push(`wind ${obs.windDeg ?? '—'}° ${obs.windKt}kt${obs.gustKt ? ` G${obs.gustKt}` : ''}`);
    if (obs.wx) bits.push(obs.wx);
    return bits.join(' · ');
  }, [obs]);

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">Point forecast</h2>
          <p className="text-[11px] text-wx-mute">
            NWS hourly (NDFD) · 48 h · {loc?.office ? `WFO ${loc.office} · radar ${loc.radarStation ?? '—'} · ` : ''}
            updated {fmtUpdated(data?.updated ?? null)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => load(pt.lat, pt.lon)}
          className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[200px_1fr]">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Location</span>
          {MIDSOUTH_POINTS.map((p) => {
            const on = p.key === pt.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setPt(p)}
                className={`rounded-md px-2 py-1 text-left text-[11.5px] ${
                  on ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent' : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'
                }`}
              >
                <MapPin size={10} className="mr-1.5 inline" />
                {p.city} · {p.state}
              </button>
            );
          })}
          <form onSubmit={submitLatLon} className="mt-1 flex gap-1">
            <input
              value={latlon}
              onChange={(e) => setLatLon(e.target.value)}
              placeholder="lat, lon"
              className="min-w-0 flex-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-fg outline-none focus:border-wx-accent"
            />
            <button type="submit" className="rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent">
              Go
            </button>
          </form>
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-wx-line bg-wx-ink p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[12px] font-semibold text-wx-fg">
              {loc?.city ? `${loc.city}${loc.state ? `, ${loc.state}` : ''}` : pt.city}
            </div>
            {obsLine ? (
              <div className="flex items-center gap-1 text-[11px] text-wx-mute">
                <Wind size={11} /> Obs {obs?.station}: {obsLine}
              </div>
            ) : null}
          </div>

          {err && !data?.hourly.length ? (
            <p className="py-8 text-center text-[12px] text-wx-mute">Couldn’t load forecast ({err}).</p>
          ) : !data ? (
            <p className="py-8 text-center text-[12px] text-wx-mute">Loading…</p>
          ) : (
            <>
              <div className="flex items-center gap-3 text-[10px] text-wx-mute">
                <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: C_TEMP }} /> Temp °F</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: C_DEWP }} /> Dewpoint °F</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2" style={{ background: C_POP, opacity: 0.55 }} /> PoP %</span>
              </div>
              <div className="-mx-1 overflow-x-auto"><Meteogram hourly={data.hourly} tz={loc?.timeZone ?? null} /></div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
