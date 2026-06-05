'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Columns2, Pause, Play, RefreshCw } from 'lucide-react';
import {
  MODEL_CATALOG,
  FIELD_GROUPS,
  modelDef,
  modelField,
  type ModelDef,
  type ModelFieldDef,
} from '@/lib/forecast/model-charts';

// One-tap jumps to the fields a forecaster reads first, top-down.
const QUICK_FIELDS = [
  { key: 'jet250', label: 'Jet' },
  { key: 'vort500', label: 'Vort/Hgt' },
  { key: 'omega700', label: 'Omega' },
  { key: 'thetae850', label: 'θe' },
  { key: 'pwat', label: 'PWAT' },
  { key: 'cape', label: 'CAPE' },
  { key: 'li', label: 'LI' },
];

type ModelResult = {
  image_url: string;
  valid_time: string | null;
  cycle: string | null;
  cached: boolean;
  render_ms: number;
  error?: string;
};

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

// Self-fetching model image. Used both for the single view and each cell of the
// compare grid. fhr is clamped to the model's max so a shared slider still works
// across models with different ranges.
function ModelImage({
  modelKey, fieldKey, region, fhr, onMeta, showCaption,
}: {
  modelKey: string; fieldKey: string; region: string; fhr: number;
  onMeta?: (m: ModelResult) => void; showCaption?: boolean;
}) {
  const [res, setRes] = useState<ModelResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);
  const md = modelDef(modelKey)!;
  const eff = Math.min(fhr, md.fhr_max);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setErr(null);
    fetch(`/api/forecast/model?model=${modelKey}&field=${fieldKey}&region=${region}&fhr=${eff}`)
      .then((r) => r.json())
      .then((d: ModelResult) => {
        if (id !== reqId.current) return;
        if (d.error) setErr(d.error);
        else { setRes(d); onMeta?.(d); }
      })
      .catch((e) => { if (id === reqId.current) setErr(e?.message ?? 'fetch_error'); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, fieldKey, region, eff]);

  return (
    <div className="relative overflow-hidden rounded-md border border-wx-line bg-[#0b1220]">
      {showCaption ? (
        <div className="flex items-center justify-between px-2 py-1 text-[10px] text-wx-mute">
          <span className="font-semibold text-wx-fg">{md.label}</span>
          <span>F{String(eff).padStart(3, '0')}{res?.cached ? ' · cached' : res ? ` · ${res.render_ms}ms` : ''}</span>
        </div>
      ) : null}
      {res?.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={res.image_url} alt={`${md.label} ${fieldKey} F${eff}`} className="block w-full" />
      ) : (
        <div className="flex h-48 items-center justify-center text-[11px] text-wx-mute">
          {err ? `error (${err})` : loading ? 'Rendering…' : '—'}
        </div>
      )}
      {loading && res?.image_url ? (
        <div className="absolute right-2 top-2 rounded bg-wx-ink/90 px-2 py-1 text-[10px] text-wx-mute">rendering…</div>
      ) : null}
    </div>
  );
}

export default function ModelsPanel() {
  const [modelKey, setModelKey] = useState('gfs');
  const [fieldKey, setFieldKey] = useState('t2m');
  const [region, setRegion] = useState('midsouth');
  const [fhr, setFhr] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [compare, setCompare] = useState(false);
  const [meta, setMeta] = useState<ModelResult | null>(null);

  const model = modelDef(modelKey)!;
  const field = modelField(modelKey, fieldKey) ?? model.fields[0];
  const minFhr = startFhr(model, field);

  useEffect(() => {
    if (!modelField(modelKey, fieldKey)) setFieldKey(model.fields[0].key);
    setFhr((h) => Math.min(Math.max(h, minFhr), model.fhr_max));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  // Models that carry the current field (for the compare grid).
  const compareModels = MODEL_CATALOG.models.filter((m) => modelField(m.key, fieldKey));
  const maxFhr = compare ? Math.max(...compareModels.map((m) => m.fhr_max)) : model.fhr_max;
  const step = compare ? Math.min(...compareModels.map((m) => m.fhr_step)) : model.fhr_step;

  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      setFhr((h) => {
        const next = h + step;
        return next > maxFhr ? minFhr : next;
      });
    }, 900);
    return () => clearInterval(iv);
  }, [playing, maxFhr, step, minFhr]);

  const onMeta = useCallback((m: ModelResult) => setMeta(m), []);

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">Models (GFS · NAM · HRRR)</h2>
          <p className="text-[11px] text-wx-mute">
            Live NOMADS GRIB · cycle {fmtCycle(meta?.cycle ?? null)}
            {meta?.valid_time ? ` · valid ${fmtValid(meta.valid_time)}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCompare((c) => !c)}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
            compare ? 'border-wx-accent text-wx-accent' : 'border-wx-line bg-wx-ink text-wx-mute hover:text-wx-fg hover:border-wx-accent'
          }`}
        >
          <Columns2 size={11} /> Compare models
        </button>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        {!compare ? (
          <label className="flex flex-col gap-1 text-[11px]">
            <span className="font-semibold uppercase tracking-wider text-wx-mute">Model</span>
            <select value={modelKey} onChange={(e) => setModelKey(e.target.value)}
              className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent">
              {MODEL_CATALOG.models.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Field</span>
          <select value={fieldKey} onChange={(e) => setFieldKey(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent">
            {FIELD_GROUPS.map((g) => {
              const fs = (compare ? MODEL_CATALOG.models[0].fields : model.fields).filter((f) => f.group === g);
              return fs.length ? (
                <optgroup key={g} label={g}>
                  {fs.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.unit})</option>)}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Region</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent">
            {MODEL_CATALOG.regions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>

        <button type="button" onClick={() => setPlaying((p) => !p)}
          className="inline-flex items-center gap-1.5 rounded-md border border-wx-line bg-wx-ink px-3 py-1.5 text-xs text-wx-mute hover:text-wx-fg hover:border-wx-accent">
          {playing ? <Pause size={12} /> : <Play size={12} />} {playing ? 'Stop' : 'Loop'}
        </button>

        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">
            Forecast hour · <span className="font-mono text-wx-fg">F{String(fhr).padStart(3, '0')}</span>
          </span>
          <input type="range" min={minFhr} max={maxFhr} step={step} value={fhr}
            onChange={(e) => setFhr(parseInt(e.target.value, 10))} className="w-full accent-wx-accent" />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        <span className="font-semibold uppercase tracking-wider text-wx-mute">Quick</span>
        {QUICK_FIELDS.map((q) => (modelField(modelKey, q.key) ? (
          <button
            key={q.key}
            type="button"
            onClick={() => setFieldKey(q.key)}
            className={`rounded-md border px-2 py-1 ${
              fieldKey === q.key
                ? 'border-wx-accent text-wx-accent'
                : 'border-wx-line bg-wx-ink text-wx-mute hover:text-wx-fg hover:border-wx-accent'
            }`}
          >
            {q.label}
          </button>
        ) : null))}
      </div>

      {compare ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {compareModels.map((m) => (
            <ModelImage key={m.key} modelKey={m.key} fieldKey={fieldKey} region={region} fhr={fhr} showCaption />
          ))}
        </div>
      ) : (
        <ModelImage modelKey={modelKey} fieldKey={fieldKey} region={region} fhr={fhr} onMeta={onMeta} />
      )}
    </section>
  );
}
