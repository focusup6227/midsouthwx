'use client';

import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  RAOB_STATIONS,
  RAOB_DEFAULT_STN,
  uwyoUrl,
  spcSoundingUrl,
  iemSoundingUrl,
  type RaobStation,
} from '@/lib/forecast/soundings';

function fmtUtcReleaseHint(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const release = hour >= 12 ? '12Z' : '00Z';
  return `Latest released: ${release} today (UTC)`;
}

export default function SoundingPanel() {
  const [stnCode, setStnCode] = useState<string>(RAOB_DEFAULT_STN);
  const stn: RaobStation = useMemo(
    () => RAOB_STATIONS.find((s) => s.spcStn === stnCode) ?? RAOB_STATIONS[0],
    [stnCode],
  );

  return (
    <section className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-wx-fg">RAOB Soundings</h2>
          <p className="text-[11px] text-wx-mute">{fmtUtcReleaseHint()} · open in a new tab</p>
        </div>
      </header>

      <div className="grid gap-2 sm:grid-cols-[200px_1fr]">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Station</span>
          {RAOB_STATIONS.map((s) => {
            const on = s.spcStn === stnCode;
            return (
              <button
                key={s.spcStn}
                type="button"
                onClick={() => setStnCode(s.spcStn)}
                className={`rounded-md px-2 py-1 text-left text-[11.5px] ${
                  on
                    ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent'
                    : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'
                }`}
              >
                <span className="font-mono mr-1.5 text-[10px] uppercase">{s.spcStn}</span>
                {s.name} · {s.state}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-3 rounded-md border border-wx-line bg-wx-ink p-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">{stn.spcStn} — {stn.name}, {stn.state}</div>
            <div className="mt-0.5 text-[11px] text-wx-mute">WMO {stn.wmo} · IEM {stn.iemStn}</div>
          </div>

          <div className="flex flex-col gap-2">
            <a
              href={uwyoUrl(stn)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-between rounded-md border border-wx-line bg-wx-card px-3 py-2 text-xs text-wx-fg hover:border-wx-accent hover:text-wx-accent"
            >
              <span>
                <span className="font-semibold">University of Wyoming</span>
                <span className="ml-1.5 text-wx-mute">Skew-T GIF · current release</span>
              </span>
              <ExternalLink size={12} />
            </a>
            <a
              href={spcSoundingUrl(stn)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-between rounded-md border border-wx-line bg-wx-card px-3 py-2 text-xs text-wx-fg hover:border-wx-accent hover:text-wx-accent"
            >
              <span>
                <span className="font-semibold">SPC sounding viewer</span>
                <span className="ml-1.5 text-wx-mute">Interactive · annotated by SPC</span>
              </span>
              <ExternalLink size={12} />
            </a>
            <a
              href={iemSoundingUrl(stn)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-between rounded-md border border-wx-line bg-wx-card px-3 py-2 text-xs text-wx-fg hover:border-wx-accent hover:text-wx-accent"
            >
              <span>
                <span className="font-semibold">IEM RAOB archive</span>
                <span className="ml-1.5 text-wx-mute">Iowa State Mesonet · historical browser</span>
              </span>
              <ExternalLink size={12} />
            </a>
          </div>

          <p className="text-[10.5px] text-wx-mute">
            Soundings are released at 00Z and 12Z; the page on the upstream service shows the latest available data for the selected station.
          </p>
        </div>
      </div>
    </section>
  );
}
