import Link from 'next/link';
import DashShell from '@/components/DashShell';
import MesoanalysisPanel from './_components/MesoanalysisPanel';
import ModelsPanel from './_components/ModelsPanel';
import PointForecastPanel from './_components/PointForecastPanel';
import SevereParamsPanel from './_components/SevereParamsPanel';
import ForecastSoundingPanel from './_components/ForecastSoundingPanel';
import SoundingPanel from './_components/SoundingPanel';

export const dynamic = 'force-dynamic';

// Decision-support viewers for the forecasting workflow. Panels here:
//   - Point forecast (NWS hourly NDFD meteogram + nearest obs)
//   - Severe ingredients (HRRR CAPE/CIN/SRH/shear at a point — same data the AI uses)
//   - Models (GFS/NAM/HRRR fields from NOMADS GRIB by forecast hour; model compare)
//   - SPC Mesoanalysis (raster GIFs, ~30-min cadence; 1/2/4-up compare)
//   - Forecast sounding (Skew-T rendered from a model column via MetPy)
//   - RAOB soundings (external viewer links per station)
//
// Kept on a dedicated route rather than bolted onto /forecast/new so the
// operator can pop it in a side tab while drafting, and can also reach it
// directly from the dashboard nav. Model-overlay fields (HRRR REFC, NDFD
// temp/dewpoint/RH/sky/wind/gust, WPC QPF) live in /radar's existing
// inspector picker — that's where Mapbox basemap context matters; here we
// only need static rasters + external links.

export default function ForecastDataPage() {
  return (
    <DashShell
      title="Forecast data viewers"
      width="wide"
      backHref="/forecast"
      actions={
        <Link
          href="/forecast/new"
          className="inline-flex items-center gap-2 rounded-lg bg-wx-accent px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-300"
        >
          Draft a forecast
        </Link>
      }
    >
      <div className="space-y-4">
        <PointForecastPanel />
        <SevereParamsPanel />
        <ModelsPanel />
        <MesoanalysisPanel />
        <ForecastSoundingPanel />
        <SoundingPanel />
      </div>
    </DashShell>
  );
}
