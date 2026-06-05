'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  SAT_BANDS,
  SAT_SATELLITES,
  SAT_DEFAULT_BAND,
  satSatellite,
  satImageUrl,
  satStarPage,
  type SatBand,
} from '@/lib/radar/satellite';

// STAR refreshes the sector image every ~5–15 min; bust the cache on that scale.
const REFRESH_MS = 5 * 60 * 1000;

const BAND_GROUPS: SatBand['group'][] = ['RGB', 'Clouds', 'Water vapor'];

export default function SatellitePanel() {
  const [satKey, setSatKey] = useState('east');
  const sat = satSatellite(satKey);
  const [sector, setSector] = useState(sat.defaultSector);
  const [band, setBand] = useState(SAT_DEFAULT_BAND);
  const [cacheKey, setCacheKey] = useState(() => Math.floor(Date.now() / REFRESH_MS));

  useEffect(() => {
    const id = setInterval(() => setCacheKey(Math.floor(Date.now() / REFRESH_MS)), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Switching satellite resets the sector to that satellite's default.
  function chooseSat(key: string) {
    setSatKey(key);
    setSector(satSatellite(key).defaultSector);
  }

  const src = satImageUrl(satKey, sector, band, cacheKey);

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">Satellite (GOES)</h2>
          <p className="text-[11px] text-wx-mute">NESDIS STAR · latest sector image · WV / IR / visible</p>
        </div>
        <div className="flex items-center gap-1.5">
          {/* East/West toggle */}
          <div className="flex overflow-hidden rounded-md border border-wx-line">
            {SAT_SATELLITES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => chooseSat(s.key)}
                className={`px-2.5 py-1 text-[11px] ${
                  satKey === s.key ? 'bg-wx-accent/15 text-wx-fg' : 'bg-wx-ink text-wx-mute hover:text-wx-fg'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setCacheKey(Math.floor(Date.now() / REFRESH_MS) + Math.random())}
            className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
          >
            <RefreshCw size={11} /> Refresh
          </button>
          <a
            href={satStarPage(satKey, sector, band)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
            title="Open on STAR (loop)"
          >
            <ExternalLink size={11} /> Loop
          </a>
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Sector</span>
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent"
          >
            {sat.sectors.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-wx-mute">Band</span>
          <select
            value={band}
            onChange={(e) => setBand(e.target.value)}
            className="rounded-md border border-wx-line bg-wx-ink px-2 py-1.5 text-xs text-wx-fg outline-none focus:border-wx-accent"
          >
            {BAND_GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {SAT_BANDS.filter((b) => b.group === g).map((b) => (
                  <option key={b.key} value={b.key}>{b.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-1">
          {['GEOCOLOR', '09', '13', '02'].map((bk) => {
            const b = SAT_BANDS.find((x) => x.key === bk)!;
            return (
              <button
                key={bk}
                type="button"
                onClick={() => setBand(bk)}
                className={`rounded-md border px-2 py-1 text-[11px] ${
                  band === bk ? 'border-wx-accent text-wx-accent' : 'border-wx-line bg-wx-ink text-wx-mute hover:text-wx-fg hover:border-wx-accent'
                }`}
              >
                {b.label.replace(/ \(.*\)/, '')}
              </button>
            );
          })}
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-wx-line bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={src} src={src} alt={`${sat.label} ${band} ${sector}`} className="mx-auto block w-full sm:max-h-[620px] sm:w-auto" loading="lazy" />
      </div>
    </section>
  );
}
