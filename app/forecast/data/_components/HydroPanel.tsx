'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { MODEL_CATALOG } from '@/lib/forecast/model-charts';

// Hydro view for the forecast workflow. Composes the precip/moisture products:
//   - WPC 5-day QPF (static national chart, geography baked in)
//   - Model APCP (forecast precip accumulation by hour) via the deployed renderer
//   - Model PWAT (atmospheric moisture) via the deployed renderer
// Observed MRMS QPE (gauge-corrected rainfall-to-date) is the one remaining hydro
// gap — it needs an MRMS GRIB render field in the sidecar (noted, deferred).

const WPC_QPF_5DAY = 'https://www.wpc.ncep.noaa.gov/qpf/p120i.gif';

function ModelImg({ field, region, fhr, label }: { field: string; region: string; fhr: number; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true); setErr(null);
    fetch(`/api/forecast/model?model=gfs&field=${field}&region=${region}&fhr=${fhr}`)
      .then((r) => r.json())
      .then((d) => { if (id === reqId.current) { d.error ? setErr(d.error) : setUrl(d.image_url); } })
      .catch((e) => { if (id === reqId.current) setErr(e?.message ?? 'err'); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [field, region, fhr]);
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold text-wx-fg">{label}{loading ? ' · …' : ''}</div>
      <div className="overflow-hidden rounded-md border border-wx-line bg-[#0b1220]">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="block w-full" />
        ) : (
          <div className="flex h-44 items-center justify-center text-[11px] text-wx-mute">{err ? `error (${err})` : 'Rendering…'}</div>
        )}
      </div>
    </div>
  );
}

export default function HydroPanel() {
  const [region, setRegion] = useState('midsouth');
  const [fhr, setFhr] = useState(24);
  const [cacheKey, setCacheKey] = useState(0);

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">Hydro (precip & moisture)</h2>
          <p className="text-[11px] text-wx-mute">WPC QPF · model precip + PWAT · observed MRMS QPE coming</p>
        </div>
        <button type="button" onClick={() => setCacheKey((k) => k + 1)}
          className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent">
          <RefreshCw size={11} /> Refresh
        </button>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Region</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent">
            {MODEL_CATALOG.regions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">
            APCP forecast hour · <span className="font-mono text-wx-fg">F{String(fhr).padStart(3, '0')}</span>
          </span>
          <input type="range" min={3} max={84} step={3} value={fhr}
            onChange={(e) => setFhr(parseInt(e.target.value, 10))} className="w-full accent-wx-accent" />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <ModelImg key={`apcp-${cacheKey}`} field="apcp" region={region} fhr={fhr} label={`GFS accumulated precip (F${String(fhr).padStart(3, '0')})`} />
        <ModelImg key={`pwat-${cacheKey}`} field="pwat" region={region} fhr={fhr} label="GFS precipitable water" />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold text-wx-fg">WPC Day 1–5 QPF (total)</div>
          <a href="https://www.wpc.ncep.noaa.gov/qpf/qpf2.shtml" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-wx-mute hover:text-wx-accent">
            <ExternalLink size={11} /> WPC (day-by-day + ERO)
          </a>
        </div>
        <div className="overflow-hidden rounded-md border border-wx-line bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${WPC_QPF_5DAY}?_t=${cacheKey}`} alt="WPC 5-day QPF" className="mx-auto block w-full sm:max-h-[520px] sm:w-auto" loading="lazy" />
        </div>
      </div>
    </section>
  );
}
