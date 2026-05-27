'use client';

import '@/lib/mapbox/patch-remove-source';

import { useEffect, useMemo, useState } from 'react';
import Map, { Source, Layer } from 'react-map-gl';
import Link from 'next/link';
import { mapboxAccessToken, mapboxStyleUrl } from '@/lib/supabase/env';

type FeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: GeoJSON.Geometry;
    properties: {
      id: string;
      name: string;
      kind: string;
      subscriber_count: number;
    };
  }[];
};

const MID_SOUTH = { longitude: -89.9, latitude: 35.1, zoom: 6 };

function countColor(n: number): string {
  if (n >= 50) return '#dc2626';
  if (n >= 20) return '#ea580c';
  if (n >= 10) return '#ca8a04';
  if (n >= 5) return '#2563eb';
  if (n >= 1) return '#0891b2';
  return '#64748b';
}

export default function MapPage() {
  const token = mapboxAccessToken();
  const [geo, setGeo] = useState<FeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ name: string; count: number } | null>(null);

  useEffect(() => {
    fetch('/api/map/regions')
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then(setGeo)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const fillExpression = useMemo(() => {
    if (!geo?.features?.length) return '#64748b';
    const stops: (number | string)[] = [0, '#334155'];
    for (const f of geo.features) {
      const n = f.properties.subscriber_count ?? 0;
      if (n > 0) stops.push(n, countColor(n));
    }
    return ['interpolate', ['linear'], ['get', 'subscriber_count'], ...stops] as unknown as string;
  }, [geo]);

  if (!token) {
    return (
      <div className="p-6 space-y-2">
        <Link href="/dashboard" className="text-sm text-wx-mute">← Dashboard</Link>
        <p className="text-wx-danger text-sm">Set NEXT_PUBLIC_MAPBOX_TOKEN to view the map.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-0px)]">
      <header className="border-b border-wx-line bg-wx-ink/95 px-4 py-3 flex items-center justify-between gap-4 shrink-0">
        <div>
          <Link href="/dashboard" className="text-xs text-wx-mute">← Dashboard</Link>
          <h1 className="text-lg font-semibold">Subscriber map</h1>
          <p className="text-xs text-wx-mute">Active subscribers per region (darker = more)</p>
        </div>
        {hover ? (
          <div className="text-sm text-right">
            <div className="font-medium">{hover.name}</div>
            <div className="text-wx-mute">{hover.count} active</div>
          </div>
        ) : null}
      </header>

      {error ? (
        <p className="p-4 text-sm text-wx-danger">{error}</p>
      ) : (
        <div className="flex-1 min-h-0">
          <Map
            mapboxAccessToken={token}
            initialViewState={MID_SOUTH}
            mapStyle={mapboxStyleUrl()}
            style={{ width: '100%', height: '100%' }}
            interactiveLayerIds={['region-fill']}
            onMouseMove={(e) => {
              const f = e.features?.[0];
              if (f?.properties) {
                setHover({
                  name: String(f.properties.name ?? ''),
                  count: Number(f.properties.subscriber_count ?? 0),
                });
              } else {
                setHover(null);
              }
            }}
            onMouseLeave={() => setHover(null)}
          >
            {geo ? (
              <Source id="regions" type="geojson" data={geo as GeoJSON.FeatureCollection}>
                <Layer
                  id="region-fill"
                  type="fill"
                  paint={{
                    'fill-color': fillExpression as never,
                    'fill-opacity': 0.55,
                  }}
                />
                <Layer
                  id="region-outline"
                  type="line"
                  paint={{
                    'line-color': '#94a3b8',
                    'line-width': 1,
                    'line-opacity': 0.6,
                  }}
                />
              </Source>
            ) : null}
          </Map>
        </div>
      )}

      {!geo && !error ? (
        <p className="absolute inset-0 flex items-center justify-center text-wx-mute text-sm pointer-events-none">
          Loading regions…
        </p>
      ) : null}

      {geo?.features?.length === 0 && !error ? (
        <p className="p-4 text-sm text-wx-mute">
          No region geometry yet. Import counties via{' '}
          <code className="text-xs">scripts/import-regions.mjs</code>.
        </p>
      ) : null}
    </div>
  );
}
