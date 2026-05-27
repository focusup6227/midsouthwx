'use client';

import { useMemo } from 'react';
import Map, { Source, Layer } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxAccessToken, mapboxStyleUrl } from '@/lib/supabase/env';

type Geometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

function bounds(geom: Geometry): [[number, number], [number, number]] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const visit = (lon: number, lat: number) => {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  };
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) for (const [lon, lat] of ring) visit(lon, lat);
  } else {
    for (const poly of geom.coordinates)
      for (const ring of poly) for (const [lon, lat] of ring) visit(lon, lat);
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

export default function AlertMap({
  geometry,
  fill,
}: {
  geometry: Geometry;
  fill: string;
}) {
  const token = mapboxAccessToken();
  const styleUrl = mapboxStyleUrl();

  // Rough zoom from bbox span — tornado/svr polygons are usually under a degree
  // wide, so this lands around zoom 8-10. Padding via -0.5 so the polygon
  // doesn't hug the viewport edge.
  const initialView = useMemo(() => {
    const [[minLon, minLat], [maxLon, maxLat]] = bounds(geometry);
    const span = Math.max(maxLon - minLon, (maxLat - minLat) * 1.4, 0.01);
    const zoom = Math.max(4, Math.min(11, Math.log2(360 / span) - 0.5));
    return {
      longitude: (minLon + maxLon) / 2,
      latitude: (minLat + maxLat) / 2,
      zoom,
    };
  }, [geometry]);

  if (!token) {
    return (
      <div className="card p-4 text-sm text-wx-mute">
        Map unavailable (no Mapbox token configured).
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden border border-wx-line h-[360px]">
      <Map
        mapboxAccessToken={token}
        mapStyle={styleUrl}
        initialViewState={initialView}
        attributionControl
        cooperativeGestures
      >
        <Source
          id="alert-polygon"
          type="geojson"
          data={{ type: 'Feature', geometry, properties: {} }}
        >
          <Layer
            id="alert-polygon-fill"
            type="fill"
            paint={{ 'fill-color': fill, 'fill-opacity': 0.25 }}
          />
          <Layer
            id="alert-polygon-line"
            type="line"
            paint={{ 'line-color': fill, 'line-width': 2 }}
          />
        </Source>
      </Map>
    </div>
  );
}
