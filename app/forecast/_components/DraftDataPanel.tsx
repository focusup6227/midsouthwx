'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, LineChart } from 'lucide-react';
import ModelsPanel from '../data/_components/ModelsPanel';
import MesoanalysisPanel from '../data/_components/MesoanalysisPanel';
import PointForecastPanel from '../data/_components/PointForecastPanel';
import SevereParamsPanel from '../data/_components/SevereParamsPanel';
import ForecastSoundingPanel from '../data/_components/ForecastSoundingPanel';
import SatellitePanel from '../data/_components/SatellitePanel';

type Tab = 'severe' | 'models' | 'satellite' | 'meso' | 'point' | 'sounding';

const TABS: { key: Tab; label: string }[] = [
  { key: 'severe', label: 'Severe' },
  { key: 'models', label: 'Models' },
  { key: 'satellite', label: 'Satellite' },
  { key: 'meso', label: 'Mesoanalysis' },
  { key: 'point', label: 'Point forecast' },
  { key: 'sounding', label: 'Sounding' },
];

// In-place data reference while drafting, so the operator doesn't have to flip
// to the /forecast/data tab. Collapsed by default and the panels are NOT
// mounted until opened — mounting ModelsPanel fires a renderer call, so we
// avoid that cost during normal form use. Tabbed (one panel at a time) to keep
// the page from getting tall and to fire only the active viewer's fetches.
export default function DraftDataPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('severe');

  return (
    <section className="rounded-lg border border-wx-line bg-wx-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-wx-fg"
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <LineChart size={14} className="text-wx-accent" />
        Forecast data
        <span className="font-normal text-wx-mute">
          {open ? '' : '— models, mesoanalysis & point forecast without leaving the draft'}
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-wx-line p-4">
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`rounded-md px-3 py-1.5 text-xs ${
                  tab === t.key
                    ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent'
                    : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* Mount only the active tab so we don't fire every viewer's fetches. */}
          {tab === 'severe' ? <SevereParamsPanel /> : null}
          {tab === 'models' ? <ModelsPanel /> : null}
          {tab === 'satellite' ? <SatellitePanel /> : null}
          {tab === 'meso' ? <MesoanalysisPanel /> : null}
          {tab === 'point' ? <PointForecastPanel /> : null}
          {tab === 'sounding' ? <ForecastSoundingPanel /> : null}
        </div>
      ) : null}
    </section>
  );
}
