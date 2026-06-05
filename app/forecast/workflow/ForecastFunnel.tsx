'use client';

import { useState } from 'react';
import {
  Globe2, Layers, Zap, CloudRain, PencilLine,
} from 'lucide-react';
import ModelsPanel from '../data/_components/ModelsPanel';
import SatellitePanel from '../data/_components/SatellitePanel';
import EnsemblePlumePanel from '../data/_components/EnsemblePlumePanel';
import MesoanalysisPanel from '../data/_components/MesoanalysisPanel';
import PointForecastPanel from '../data/_components/PointForecastPanel';
import SevereParamsPanel from '../data/_components/SevereParamsPanel';
import ForecastSoundingPanel from '../data/_components/ForecastSoundingPanel';
import HydroPanel from '../data/_components/HydroPanel';
import ForecastFormLoader from '../_components/ForecastFormLoader';

type StageKey = 'synoptic' | 'mesoscale' | 'storm' | 'hydro' | 'build';

const STAGES: {
  key: StageKey;
  label: string;
  icon: typeof Globe2;
  question: string;
}[] = [
  { key: 'synoptic', label: 'Synoptic', icon: Globe2, question: 'What is the large-scale pattern? Upper-air flow, jet, moisture, and ensemble spread.' },
  { key: 'mesoscale', label: 'Mesoscale', icon: Layers, question: 'What is the regional setup? Mesoanalysis, surface obs, satellite, point trends.' },
  { key: 'storm', label: 'Storm-scale', icon: Zap, question: 'What is the storm-scale threat? Severe ingredients and soundings.' },
  { key: 'hydro', label: 'Hydro', icon: CloudRain, question: 'What is the rainfall/flood picture? QPF, precip timing, moisture.' },
  { key: 'build', label: 'Build', icon: PencilLine, question: 'Draw the area, let the AI draft from the data, and publish.' },
];

export default function ForecastFunnel() {
  const [stage, setStage] = useState<StageKey>('synoptic');

  return (
    <div className="space-y-4">
      {/* Stage stepper — single scrollable row on phones, wraps on desktop. */}
      <nav className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
        {STAGES.map((s, i) => {
          const on = s.key === stage;
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setStage(s.key)}
              className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-3 py-2 text-sm ${
                on
                  ? 'border-wx-accent bg-wx-accent/15 text-wx-fg'
                  : 'border-wx-line bg-wx-card text-wx-mute hover:text-wx-fg hover:border-wx-accent'
              }`}
            >
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${on ? 'bg-wx-accent text-black' : 'bg-wx-ink'}`}>
                {i + 1}
              </span>
              <Icon size={14} />
              {s.label}
            </button>
          );
        })}
      </nav>

      <p className="text-[12px] text-wx-mute">{STAGES.find((s) => s.key === stage)!.question}</p>

      {/* Only the active stage is mounted, so each viewer's fetches fire on demand. */}
      {stage === 'synoptic' ? (
        <div className="space-y-4">
          <ModelsPanel />
          <SatellitePanel />
          <EnsemblePlumePanel />
        </div>
      ) : null}

      {stage === 'mesoscale' ? (
        <div className="space-y-4">
          <MesoanalysisPanel />
          <PointForecastPanel />
          <SatellitePanel />
        </div>
      ) : null}

      {stage === 'storm' ? (
        <div className="space-y-4">
          <SevereParamsPanel />
          <ForecastSoundingPanel />
        </div>
      ) : null}

      {stage === 'hydro' ? (
        <div className="space-y-4">
          <HydroPanel />
        </div>
      ) : null}

      {stage === 'build' ? (
        <div className="space-y-3">
          <p className="text-[12px] text-wx-mute">
            Draw the forecast area, set hazards/confidence/window, then <span className="text-wx-fg">AI draft</span> grounds
            the discussion in the data you just reviewed (SPC outlook, AFD, alerts, LSRs, Open-Meteo thermo, and HRRR
            severe params). Review, then Save.
          </p>
          <ForecastFormLoader initialArea={null} />
        </div>
      ) : null}
    </div>
  );
}
