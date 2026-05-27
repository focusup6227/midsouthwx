'use client';

import '@/lib/mapbox/patch-remove-source';

import { useEffect, useMemo, useRef, useState } from 'react';
import Map, { Source, Layer, type MapRef } from 'react-map-gl';
import { mapboxAccessToken, mapboxStyleUrl } from '@/lib/supabase/env';

type Props = {
  geometry: GeoJSON.Geometry | null;
  height?: number;
  label?: string;
};

const FALLBACK_VIEW = { longitude: -89.9, latitude: 35.1, zoom: 5 };

export default function GeometryPreview({ geometry, height = 280, label }: Props) {
  const token = mapboxAccessToken();
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);

  const data = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!geometry) return null;
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry, properties: {} }],
    };
  }, [geometry]);

  const bounds = useMemo(() => geometryBounds(geometry), [geometry]);

  useEffect(() => {
    if (!ready || !mapRef.current || !bounds) return;
    mapRef.current.fitBounds(
      [
        [bounds.minLng, bounds.minLat],
        [bounds.maxLng, bounds.maxLat],
      ],
      { padding: 24, duration: 250, maxZoom: 10 },
    );
  }, [ready, bounds]);

  if (!token) {
    return (
      <div
        className="rounded border border-wx-line bg-wx-ink/40 p-4 text-xs text-wx-mute"
        style={{ height }}
      >
        Set NEXT_PUBLIC_MAPBOX_TOKEN to preview geometry.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {label ? <div className="text-xs uppercase tracking-wide text-wx-mute">{label}</div> : null}
      <div
        className="overflow-hidden rounded border border-wx-line"
        style={{ height }}
      >
        <Map
          ref={(r) => {
            mapRef.current = r;
          }}
          onLoad={() => setReady(true)}
          mapboxAccessToken={token}
          initialViewState={FALLBACK_VIEW}
          mapStyle={mapboxStyleUrl()}
          style={{ width: '100%', height: '100%' }}
          // Keep the default Mapbox attribution control on — Mapbox + OSM
          // require credit on any rendered map, including small previews,
          // and there is no other map on the /regions page to inherit it
          // from.
        >
          {data ? (
            <Source id="region" type="geojson" data={data}>
              <Layer
                id="region-fill"
                type="fill"
                paint={{ 'fill-color': '#fbbf24', 'fill-opacity': 0.25 }}
              />
              <Layer
                id="region-outline"
                type="line"
                paint={{ 'line-color': '#fbbf24', 'line-width': 1.5 }}
              />
            </Source>
          ) : null}
        </Map>
      </div>
    </div>
  );
}

function geometryBounds(g: GeoJSON.Geometry | null) {
  if (!g) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const lng = coords[0];
      const lat = coords[1];
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    coords.forEach(visit);
  };
  if ('coordinates' in g) visit((g as GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon | GeoJSON.MultiPolygon).coordinates);
  if ('geometries' in g) {
    for (const sub of g.geometries) {
      if ('coordinates' in sub) {
        visit((sub as GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon | GeoJSON.MultiPolygon).coordinates);
      }
    }
  }
  if (!Number.isFinite(minLng)) return null;
  return { minLng, minLat, maxLng, maxLat };
}
