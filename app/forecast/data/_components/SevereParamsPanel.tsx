'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin, RefreshCw, Zap } from 'lucide-react';
import { MIDSOUTH_POINTS, DEFAULT_POINT, type ForecastPoint } from '@/lib/forecast/points';
import type { SevereSample } from '@/lib/forecast/severe-sample';

// Ascending thresholds → tone. Higher value = more supportive of severe.
function tone(v: number | null, t: [number, number, number]): string {
  if (v == null) return 'text-wx-mute';
  if (v >= t[2]) return 'text-wx-danger';
  if (v >= t[1]) return 'text-orange-400';
  if (v >= t[0]) return 'text-yellow-400';
  return 'text-wx-mute';
}

function Metric({ label, value, unit, color }: { label: string; value: number | null; unit: string; color: string }) {
  return (
    <div className="rounded-md border border-wx-line bg-wx-ink p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">{label}</div>
      <div className={`mt-0.5 font-mono text-lg ${color}`}>
        {value == null ? '—' : value}
        <span className="ml-1 text-[10px] text-wx-mute">{unit}</span>
      </div>
    </div>
  );
}

export default function SevereParamsPanel() {
  const [pt, setPt] = useState<ForecastPoint>(DEFAULT_POINT);
  const [data, setData] = useState<SevereSample | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/forecast/severe?lat=${pt.lat}&lon=${pt.lon}`);
      const d = await r.json();
      if (id !== reqId.current) return;
      if (d.error) setErr(d.error);
      else setData(d);
    } catch (e: any) {
      if (id === reqId.current) setErr(e?.message ?? 'fetch_error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [pt.lat, pt.lon]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-wx-fg">
            <Zap size={13} className="text-wx-accent" /> Severe ingredients
          </h2>
          <p className="text-[11px] text-wx-mute">
            {data?.model ?? 'HRRR'} current analysis · the same numbers the AI draft reasons from
          </p>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </header>

      <div className="flex flex-wrap gap-1">
        {MIDSOUTH_POINTS.map((p) => {
          const on = p.key === pt.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setPt(p)}
              className={`rounded-md px-2 py-1 text-[11px] ${
                on ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent' : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'
              }`}
            >
              <MapPin size={9} className="mr-1 inline" />{p.city}
            </button>
          );
        })}
      </div>

      {err && !data ? (
        <p className="py-6 text-center text-[12px] text-wx-mute">Couldn’t sample ({err}).</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="SBCAPE" value={data?.sbcape ?? null} unit="J/kg" color={tone(data?.sbcape ?? null, [500, 1500, 2500])} />
          <Metric label="SBCIN" value={data?.sbcin ?? null} unit="J/kg" color="text-wx-fg" />
          <Metric label="0-1 SRH" value={data?.srh_0_1km ?? null} unit="m²/s²" color={tone(data?.srh_0_1km ?? null, [100, 150, 300])} />
          <Metric label="0-3 SRH" value={data?.srh_0_3km ?? null} unit="m²/s²" color={tone(data?.srh_0_3km ?? null, [150, 250, 400])} />
          <Metric label="0-1 shear" value={data?.shear_0_1km_kt ?? null} unit="kt" color={tone(data?.shear_0_1km_kt ?? null, [15, 25, 35])} />
          <Metric label="0-6 shear" value={data?.shear_0_6km_kt ?? null} unit="kt" color={tone(data?.shear_0_6km_kt ?? null, [25, 35, 50])} />
        </div>
      )}
      <p className="text-[10px] text-wx-mute">
        Color scales with severe-storm support (muted → yellow → orange → red). HRRR analysis nearest the city; for a drawn area the AI draft samples the centroid.
      </p>
    </section>
  );
}
