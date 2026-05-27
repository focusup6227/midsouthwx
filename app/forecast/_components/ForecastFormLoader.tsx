'use client';

import dynamic from 'next/dynamic';

// Same lazy-load pattern as app/radar/_components/RadarRoute.tsx — Mapbox +
// react-map-gl is a chunky bundle that we don't want to ship on first paint
// when the operator is just hitting the /forecast list. Pulling it in only
// when they actually open the form keeps cold loads fast.
const ForecastForm = dynamic(() => import('./ForecastForm'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[60vh] items-center justify-center rounded-lg border border-wx-line bg-wx-card text-sm text-wx-mute">
      Loading map…
    </div>
  ),
});

type Props = {
  initialArea: GeoJSON.Polygon | null;
};

export default function ForecastFormLoader(props: Props) {
  return <ForecastForm {...props} />;
}
