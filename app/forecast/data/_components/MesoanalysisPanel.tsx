'use client';

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  MESO_FIELDS,
  MESO_SECTORS,
  MESO_PRESETS,
  MESO_DEFAULT_SECTOR,
  MESO_DEFAULT_FIELD,
  mesoUrl,
  type MesoanalysisField,
} from '@/lib/forecast/mesoanalysis';

// Cache-bust window is 10 min — SPC updates every ~30 min during the day,
// so a slightly stale image while panning is fine.
const REFRESH_MS = 10 * 60 * 1000;

const GROUP_LABEL: Record<MesoanalysisField['group'], string> = {
  synoptic:  'Synoptic',
  thermo:    'Thermodynamic',
  kinematic: 'Kinematic',
  composite: 'Composite',
};

const GROUP_ORDER: MesoanalysisField['group'][] = ['synoptic', 'thermo', 'kinematic', 'composite'];

type Layout = 1 | 2 | 4;

function fieldMeta(code: string): MesoanalysisField {
  return MESO_FIELDS.find((f) => f.code === code) ?? MESO_FIELDS[0];
}

export default function MesoanalysisPanel() {
  const [sector, setSector] = useState<string>(MESO_DEFAULT_SECTOR);
  const [layout, setLayout] = useState<Layout>(1);
  // Four slots; only the first `layout` are shown. Seeded so switching to a
  // larger grid reveals a sensible spread instead of four identical panels.
  const [fields, setFields] = useState<string[]>([
    MESO_DEFAULT_FIELD, 'shr6', 'srh1', 'stpc',
  ]);
  const [cacheKey, setCacheKey] = useState<number>(() => Math.floor(Date.now() / REFRESH_MS));

  useEffect(() => {
    const id = setInterval(() => setCacheKey(Math.floor(Date.now() / REFRESH_MS)), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const grouped = useMemo(() => {
    const out: Record<MesoanalysisField['group'], MesoanalysisField[]> = {
      synoptic: [], thermo: [], kinematic: [], composite: [],
    };
    for (const f of MESO_FIELDS) out[f.group].push(f);
    return out;
  }, []);

  function setCellField(idx: number, code: string) {
    setFields((prev) => prev.map((c, i) => (i === idx ? code : c)));
  }

  function applyPreset(preset: (typeof MESO_PRESETS)[number]) {
    setFields([...preset.fields]);
    setLayout(4);
  }

  function forceRefresh() {
    setCacheKey(Math.floor(Date.now() / REFRESH_MS) + Math.random());
  }

  const visible = fields.slice(0, layout);
  const gridCols = layout === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2';

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">SPC Mesoanalysis</h2>
          <p className="text-[11px] text-wx-mute">
            Updates ~every 30 min · latest analysis only (SPC serves no archive — use Models for forecast-hour loops)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Layout toggle */}
          <div className="flex items-center overflow-hidden rounded-md border border-wx-line">
            {([1, 2, 4] as Layout[]).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setLayout(n)}
                className={`px-2 py-1 text-[11px] ${
                  layout === n ? 'bg-wx-accent/15 text-wx-fg' : 'bg-wx-ink text-wx-mute hover:text-wx-fg'
                }`}
                title={`${n}-up`}
              >
                {n}-up
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={forceRefresh}
            className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
            title="Force refresh"
          >
            <RefreshCw size={11} /> Refresh
          </button>
        </div>
      </header>

      {/* Sector + presets row */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Sector</span>
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-xs text-wx-fg outline-none focus:border-wx-accent"
          >
            {MESO_SECTORS.map((s) => (
              <option key={s.code} value={s.code}>{s.code} · {s.label}</option>
            ))}
          </select>
        </label>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Presets</span>
        <div className="flex flex-wrap gap-1">
          {MESO_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p)}
              className="rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:border-wx-accent hover:text-wx-fg"
              title={p.fields.map((c) => fieldMeta(c).label).join(' · ')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Panel grid */}
      <div className={`grid gap-3 ${gridCols}`}>
        {visible.map((code, idx) => {
          const meta = fieldMeta(code);
          const imgSrc = mesoUrl(sector, code, cacheKey);
          const spcPage = `https://www.spc.noaa.gov/exper/mesoanalysis/${sector}/${code}/`;
          return (
            <div key={idx} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <select
                  value={code}
                  onChange={(e) => setCellField(idx, e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11.5px] text-wx-fg outline-none focus:border-wx-accent"
                >
                  {GROUP_ORDER.map((g) => (
                    <optgroup key={g} label={GROUP_LABEL[g]}>
                      {grouped[g].map((f) => (
                        <option key={f.code} value={f.code}>{f.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <a
                  href={spcPage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
                  title="Open on SPC.noaa.gov"
                >
                  <ExternalLink size={11} /> SPC
                </a>
              </div>
              {/* SPC gifs are transparent contour overlays meant for a light
                  base — a light fill keeps them readable while the card stays dark. */}
              <div className="relative rounded-md border border-wx-line bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={imgSrc}
                  src={imgSrc}
                  alt={`SPC ${meta.label} · sector ${sector}`}
                  className="block w-full"
                  loading="lazy"
                />
              </div>
              {meta.note ? (
                <p className="text-[10.5px] text-wx-mute">{meta.note}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
