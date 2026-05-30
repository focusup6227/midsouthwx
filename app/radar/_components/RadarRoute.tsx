'use client';

import dynamic from 'next/dynamic';
import RadarSkeleton from './RadarSkeleton';
import NowcastPanel from './NowcastPanel';
import type { NwsRadarAlert } from '@/lib/nws/radar';

type SpcDay = {
  day_number: number;
  geojson: GeoJSON.FeatureCollection;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  highest_label: string | null;
};

type WarningsResponse = {
  warnings: NwsRadarAlert[];
  geojson: GeoJSON.FeatureCollection;
  tracks: GeoJSON.FeatureCollection;
};

export type RadarRouteProps = {
  initialSubsGeo: GeoJSON.FeatureCollection;
  initialSpcDays: SpcDay[];
  initialWarnings: WarningsResponse;
  envWarnings?: string[];
};

// Splits the Mapbox + react-map-gl + NEXRAD lookup tables off the initial
// route bundle. The skeleton paints immediately while the chunk + Mapbox
// style load in parallel.
const RadarView = dynamic(() => import('../RadarView'), {
  ssr: false,
  loading: () => <RadarSkeleton />,
});

export default function RadarRoute(props: RadarRouteProps) {
  return (
    <>
      <RadarView {...props} />
      {/* Operator-approval couplet nowcast panel — floats over the map,
          self-contained (own SWR fetch + dispatch action), no coupling to
          RadarView's internal state. */}
      <NowcastPanel />
    </>
  );
}


