'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin, RefreshCw } from 'lucide-react';
import { MIDSOUTH_POINTS, DEFAULT_POINT, type ForecastPoint } from '@/lib/forecast/points';

type SoundingResult = {
  image_url: string;
  model: string;
  cycle: string | null;
  fhr: number;
  sbcape: number | null;
  sbcin: number | null;
  cached: boolean;
  render_ms: number;
  error?: string;
};

const MODELS = [
  { key: 'gfs', label: 'GFS 0.25°', fhrMax: 84, step: 3 },
  { key: 'nam', label: 'NAM 12 km', fhrMax: 60, step: 3 },
];

// Real RAOB launch sites near the Mid-South (mirror of renderer RAOB_OBS_STATIONS).
const RAOB_OBS = [
  { wmo: '72340', name: 'Little Rock · AR' },
  { wmo: '72235', name: 'Jackson · MS' },
  { wmo: '72230', name: 'Birmingham · AL' },
  { wmo: '72248', name: 'Shreveport · LA' },
  { wmo: '72357', name: 'Norman · OK' },
  { wmo: '72233', name: 'Slidell · LA' },
  { wmo: '72249', name: 'Fort Worth · TX' },
];

export default function ForecastSoundingPanel() {
  const [mode, setMode] = useState<'fcst' | 'obs'>('fcst');
  const [modelKey, setModelKey] = useState('gfs');
  const [pt, setPt] = useState<ForecastPoint>(DEFAULT_POINT);
  const [fhr, setFhr] = useState(0);
  const [obsWmo, setObsWmo] = useState('72340');
  const [res, setRes] = useState<SoundingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);

  const model = MODELS.find((m) => m.key === modelKey)!;

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setErr(null);
    try {
      const url = mode === 'obs'
        ? `/api/forecast/obs-sounding?wmo=${obsWmo}&name=${encodeURIComponent(RAOB_OBS.find((s) => s.wmo === obsWmo)?.name ?? '')}`
        : `/api/forecast/sounding?model=${modelKey}&lat=${pt.lat}&lon=${pt.lon}&fhr=${fhr}`;
      const r = await fetch(url);
      const d: SoundingResult = await r.json();
      if (id !== reqId.current) return;
      if (d.error) setErr(d.error);
      else setRes(d);
    } catch (e: any) {
      if (id === reqId.current) setErr(e?.message ?? 'fetch_error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [mode, modelKey, pt.lat, pt.lon, fhr, obsWmo]);

  useEffect(() => { void load(); }, [load]);

  const errMsg = err
    ? err === 'renderer_not_configured'
      ? 'Renderer not configured.'
      : err === 'renderer_timeout'
        ? 'Sounding render timed out (NOMADS slow or cycle not posted).'
        : err === 'renderer_unreachable'
          ? 'Renderer unreachable.'
          : `Render error (${err}).`
    : null;

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">Sounding (Skew-T)</h2>
          <p className="text-[11px] text-wx-mute">
            {mode === 'obs' ? 'Observed RAOB (00Z/12Z)' : 'Model column'} · parcel + hodograph + indices
            {res ? ` · ${res.cached ? 'cached' : `rendered ${res.render_ms}ms`}` : ''}
            {res?.sbcape != null ? ` · SBCAPE ${res.sbcape} J/kg` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-wx-line">
            {(['obs', 'fcst'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 text-[11px] ${
                  mode === m ? 'bg-wx-accent/15 text-wx-fg' : 'bg-wx-ink text-wx-mute hover:text-wx-fg'
                }`}
              >
                {m === 'obs' ? 'Observed' : 'Forecast'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => load()}
            className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        <div className="flex flex-col gap-2">
          {mode === 'obs' ? (
            <>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">RAOB station</span>
              <div className="flex flex-col gap-0.5">
                {RAOB_OBS.map((s) => {
                  const on = s.wmo === obsWmo;
                  return (
                    <button
                      key={s.wmo}
                      type="button"
                      onClick={() => setObsWmo(s.wmo)}
                      className={`rounded-md px-2 py-1 text-left text-[11.5px] ${
                        on ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent' : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'
                      }`}
                    >
                      <MapPin size={10} className="mr-1.5 inline" />{s.name}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-[11px]">
                <span className="font-semibold uppercase tracking-wider text-wx-mute">Model</span>
                <select
                  value={modelKey}
                  onChange={(e) => setModelKey(e.target.value)}
                  className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent"
                >
                  {MODELS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </label>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Location</span>
              <div className="flex flex-col gap-0.5">
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
              </div>
              <label className="flex flex-col gap-1 text-[11px]">
                <span className="font-semibold uppercase tracking-wider text-wx-mute">
                  Forecast hour · <span className="font-mono text-wx-fg">F{String(fhr).padStart(3, '0')}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={model.fhrMax}
                  step={model.step}
                  value={fhr}
                  onChange={(e) => setFhr(parseInt(e.target.value, 10))}
                  className="w-full accent-wx-accent"
                />
              </label>
            </>
          )}
        </div>

        <div className="relative flex items-center justify-center rounded-md border border-wx-line bg-[#0b1220]">
          {res?.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={res.image_url} alt={`${model.label} sounding ${pt.city} F${fhr}`} className="block w-full sm:max-h-[560px] sm:w-auto" />
          ) : (
            <div className="flex h-80 items-center justify-center text-[12px] text-wx-mute">
              {errMsg ?? (loading ? 'Rendering sounding…' : 'Select a point')}
            </div>
          )}
          {loading && res?.image_url ? (
            <div className="absolute right-2 top-2 rounded bg-wx-ink/90 px-2 py-1 text-[10px] text-wx-mute">rendering…</div>
          ) : null}
          {errMsg && res?.image_url ? (
            <div className="absolute inset-x-0 bottom-0 bg-wx-danger/80 px-2 py-1 text-center text-[10px] text-black">{errMsg}</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
