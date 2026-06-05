import Link from 'next/link';
import DashShell from '@/components/DashShell';
import ForecastFunnel from './ForecastFunnel';

export const dynamic = 'force-dynamic';

// The Forecast Funnel — a guided top-down forecasting workflow that composes the
// existing data viewers into stages (Synoptic → Mesoscale → Storm-scale → Hydro
// → Build), so a forecaster can research and write a forecast in one place
// without leaving the site. Panels are the same components used on /forecast/data;
// only the active stage is mounted.
export default function ForecastWorkflowPage() {
  return (
    <DashShell
      title="Forecast workflow"
      width="wide"
      backHref="/forecast"
      actions={
        <Link
          href="/forecast/data"
          className="inline-flex items-center gap-2 rounded-lg border border-wx-line bg-wx-ink px-3 py-1.5 text-sm font-semibold text-wx-fg hover:border-wx-accent hover:text-wx-accent"
        >
          All data viewers
        </Link>
      }
    >
      <ForecastFunnel />
    </DashShell>
  );
}
