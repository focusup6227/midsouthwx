'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw } from 'lucide-react';
import {
  MODEL_CATALOG,
  modelDef,
  modelField,
  type ModelDef,
  type ModelFieldDef,
} from '@/lib/forecast/model-charts';

type ModelResult = {
  image_url: string;
  bounds: Record<string, number>;
  valid_time: string | null;
  cycle: string | null;
  label: string | null;
  unit: string | null;
  source: string | null;
  cached: boolean;
  render_ms: number;
  error?: string;
};

// First valid forecast hour for a field (precip accum is undefined at F000).
function startFhr(model: ModelDef, field: ModelFieldDef): number {
  return field.min_fhr > 0 ? Math.max(field.min_fhr, model.fhr_step) : 0;
}

function fmtCycle(c: string | null): string {
  if (!c || c.length < 10) return '—';
  return `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)} ${c.slice(8, 10)}Z`;
}
function fmtValid(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', day: 'numeric', month: 'short' });
}

export default function ModelsPanel() {
  const [modelKey, setModelKey] = useState('gfs');
  const [fieldKey, setFieldKey] = useState('t2m');
  const [region, setRegion] = useState('midsouth');
  const [fhr, setFhr] = useState(0);
  const [res, setRes] = useState<ModelResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const reqId = useRef(0);

  const model = modelDef(modelKey)!;
  const field = modelField(modelKey, fieldKey) ?? model.fields[0];
  const minFhr = startFhr(model, field);

  // Keep field + fhr valid whenever the model changes.
  useEffect(() => {
    if (!modelField(modelKey, fieldKey)) {
      setFieldKey(model.fields[0].key);
    }
    setFhr((h) => Math.min(Math.max(h, minFhr), model.fhr_max));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/forecast/model?model=${modelKey}&field=${fieldKey}&region=${region}&fhr=${fhr}`);
      const d: ModelResult = await r.json();
      if (id !== reqId.current) return;
      if (d.error) { setErr(d.error); }
      else { setRes(d); } // keep previous image on error so the loop doesn't flash
    } catch (e: any) {
      if (id === reqId.current) setErr(e?.message ?? 'fetch_error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [modelKey, fieldKey, region, fhr]);

  useEffect(() => { void load(); }, [load]);

  // Loop: advance the forecast hour on an interval. First pass renders each
  // frame server-side (slower); subsequent passes are cache hits.
  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      setFhr((h) => {
        const next = h + model.fhr_step;
        return next > model.fhr_max ? minFhr : next;
      });
    }, 900);
    return () => clearInterval(iv);
  }, [playing, model.fhr_max, model.fhr_step, minFhr]);

  const errMsg = err
    ? err === 'renderer_not_configured'
      ? 'Renderer not configured (set RENDERER_BASE_URL / RENDERER_TOKEN).'
      : err === 'renderer_timeout'
        ? 'Render timed out — NOMADS may be slow or the cycle isn’t posted yet.'
        : err === 'renderer_unreachable'
          ? 'Renderer unreachable (is the Fly service deployed/awake?).'
          : `Render error (${err}).`
    : null;

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">Models (GFS · NAM · HRRR)</h2>
          <p className="text-[11px] text-wx-mute">
            Live NOMADS GRIB · cycle {fmtCycle(res?.cycle ?? null)}
            {res?.valid_time ? ` · valid ${fmtValid(res.valid_time)}` : ''}
            {res ? ` · ${res.cached ? 'cached' : `rendered ${res.render_ms}ms`}` : ''}
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

      {/* controls */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Model</span>
          <select
            value={modelKey}
            onChange={(e) => setModelKey(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent"
          >
            {MODEL_CATALOG.models.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Field</span>
          <select
            value={fieldKey}
            onChange={(e) => setFieldKey(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent"
          >
            {model.fields.map((f) => (
              <option key={f.key} value={f.key}>{f.label} ({f.unit})</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Region</span>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent"
          >
            {MODEL_CATALOG.regions.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="inline-flex items-center gap-1.5 rounded-md border border-wx-line bg-wx-ink px-3 py-1.5 text-xs text-wx-mute hover:text-wx-fg hover:border-wx-accent"
        >
          {playing ? <Pause size={12} /> : <Play size={12} />} {playing ? 'Stop' : 'Loop'}
        </button>

        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">
            Forecast hour · <span className="font-mono text-wx-fg">F{String(fhr).padStart(3, '0')}</span>
          </span>
          <input
            type="range"
            min={minFhr}
            max={model.fhr_max}
            step={model.fhr_step}
            value={fhr}
            onChange={(e) => setFhr(parseInt(e.target.value, 10))}
            className="w-full accent-wx-accent"
          />
        </label>
      </div>

      {/* image */}
      <div className="relative overflow-hidden rounded-md border border-wx-line bg-[#0b1220]">
        {res?.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={res.image_url}
            alt={`${model.label} ${field.label} F${fhr}`}
            className="block w-full"
          />
        ) : (
          <div className="flex h-64 items-center justify-center text-[12px] text-wx-mute">
            {errMsg ?? (loading ? 'Rendering…' : 'Select a field')}
          </div>
        )}
        {loading && res?.image_url ? (
          <div className="absolute right-2 top-2 rounded bg-wx-ink/90 px-2 py-1 text-[10px] text-wx-mute">
            rendering F{String(fhr).padStart(3, '0')}…
          </div>
        ) : null}
        {errMsg && res?.image_url ? (
          <div className="absolute inset-x-0 bottom-0 bg-wx-danger/80 px-2 py-1 text-center text-[10px] text-black">
            {errMsg}
          </div>
        ) : null}
      </div>
    </section>
  );
}
