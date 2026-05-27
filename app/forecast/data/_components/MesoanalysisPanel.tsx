'use client';

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  MESO_FIELDS,
  MESO_SECTORS,
  MESO_DEFAULT_FIELD,
  MESO_DEFAULT_SECTOR,
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

export default function MesoanalysisPanel() {
  const [sector, setSector] = useState<string>(MESO_DEFAULT_SECTOR);
  const [field, setField] = useState<string>(MESO_DEFAULT_FIELD);
  const [cacheKey, setCacheKey] = useState<number>(() => Math.floor(Date.now() / REFRESH_MS));

  useEffect(() => {
    const id = setInterval(() => setCacheKey(Math.floor(Date.now() / REFRESH_MS)), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Group the field menu so the operator sees thermo/kinematic clusters
  // instead of one long list.
  const grouped = useMemo(() => {
    const out: Record<MesoanalysisField['group'], MesoanalysisField[]> = {
      synoptic: [], thermo: [], kinematic: [], composite: [],
    };
    for (const f of MESO_FIELDS) out[f.group].push(f);
    return out;
  }, []);

  const active = MESO_FIELDS.find((f) => f.code === field) ?? MESO_FIELDS[0];
  const imgSrc = mesoUrl(sector, active.code, cacheKey);
  const spcPage = `https://www.spc.noaa.gov/exper/mesoanalysis/${sector}/${active.code}/`;

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">SPC Mesoanalysis</h2>
          <p className="text-[11px] text-wx-mute">Updates ~every 30 min · {active.note ?? active.label}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setCacheKey(Math.floor(Date.now() / REFRESH_MS) + Math.random())}
            className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
            title="Force refresh"
          >
            <RefreshCw size={11} /> Refresh
          </button>
          <a
            href={spcPage}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
            title="Open on SPC.noaa.gov"
          >
            <ExternalLink size={11} /> SPC
          </a>
        </div>
      </header>

      <div className="grid gap-2 sm:grid-cols-[200px_1fr]">
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[11px]">
            <span className="font-semibold uppercase tracking-wider text-wx-mute">Sector</span>
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent"
            >
              {MESO_SECTORS.map((s) => (
                <option key={s.code} value={s.code}>{s.code} · {s.label}</option>
              ))}
            </select>
          </label>

          {(Object.keys(grouped) as Array<MesoanalysisField['group']>).map((g) => (
            <div key={g}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">{GROUP_LABEL[g]}</div>
              <div className="mt-1 flex flex-col gap-0.5">
                {grouped[g].map((f) => {
                  const on = f.code === field;
                  return (
                    <button
                      key={f.code}
                      type="button"
                      onClick={() => setField(f.code)}
                      className={`rounded-md px-2 py-1 text-left text-[11.5px] ${
                        on
                          ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent'
                          : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'
                      }`}
                    >
                      <span className="font-mono mr-1.5 text-[10px] uppercase">{f.code}</span>
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="relative rounded-md border border-wx-line bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={imgSrc}
            src={imgSrc}
            alt={`SPC ${active.label} · sector ${sector}`}
            className="block w-full"
            loading="lazy"
          />
        </div>
      </div>
    </section>
  );
}
