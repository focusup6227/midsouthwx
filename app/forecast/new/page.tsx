import Link from 'next/link';
import DashShell from '@/components/DashShell';
import ForecastFormLoader from '../_components/ForecastFormLoader';

export const dynamic = 'force-dynamic';

// Parses the ?geo= query param into a Polygon (the only shape ForecastForm
// supports). Accepts the same loose shapes /compose accepts (single ring vs.
// nested rings) so the radar "Forecast this area" shortcut can post the
// existing { type: 'polygon', coordinates: ring } shape without conversion.
// See app/compose/page.tsx:14-42 for the canonical normalizer.
function parsePolygonParam(raw: string | undefined): GeoJSON.Polygon | null {
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as { type?: unknown; coordinates?: unknown };
    const t = String(g.type ?? '').toLowerCase();
    if (t !== 'polygon') return null;
    const coords = g.coordinates;
    if (!Array.isArray(coords) || coords.length === 0) return null;
    const isNestedRings = Array.isArray(coords[0]) && Array.isArray((coords as unknown[][])[0]?.[0]);
    const rings = isNestedRings ? (coords as number[][][]) : [coords as unknown as number[][]];
    if (rings.length === 0 || rings[0].length < 4) return null;
    return { type: 'Polygon', coordinates: rings as number[][][] };
  } catch {
    return null;
  }
}

export default function NewForecastPage({
  searchParams,
}: {
  searchParams: { geo?: string };
}) {
  const initialArea = parsePolygonParam(searchParams.geo);
  return (
    <DashShell
      title="New forecast"
      width="wide"
      backHref="/forecast"
      actions={
        <Link
          href="/forecast/data"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-wx-line bg-wx-ink px-3 py-1.5 text-sm font-semibold text-wx-fg hover:border-wx-accent hover:text-wx-accent"
        >
          Data viewers ↗
        </Link>
      }
    >
      <ForecastFormLoader initialArea={initialArea} />
    </DashShell>
  );
}
