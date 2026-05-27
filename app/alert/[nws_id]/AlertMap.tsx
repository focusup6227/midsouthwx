'use client';

import { useEffect, useMemo, useState } from 'react';
import Map, { Source, Layer } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { mapboxAccessToken, mapboxStyleUrl } from '@/lib/supabase/env';

type Geometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

// LibreWxR Weather Maps API — same source the operator dashboard's /radar uses.
// Public, CC-BY-4.0 (attribution lives in the Mapbox attribution control).
// Color scheme 8 = Dark Sky palette (matches /radar default); "1_1" = smoothed + snow-aware.
const LIBREWXR_INDEX_URL = 'https://api.librewxr.net/public/weather-maps.json';
const LIBREWXR_TILE_SIZE = 512;
const LIBREWXR_MAX_ZOOM = 7;
const LIBREWXR_COLOR = 8;
const LIBREWXR_OPTS = '1_1';

type LwxrFrame = { time: number; path: string };
type LwxrIndex = { host: string; latest: LwxrFrame };

async function fetchLwxrIndex(signal: AbortSignal): Promise<LwxrIndex | null> {
  try {
    const r = await fetch(LIBREWXR_INDEX_URL, { cache: 'no-store', signal });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      host?: string;
      radar?: { nowcast?: LwxrFrame[]; past?: LwxrFrame[] };
    };
    const host = j.host;
    const nowcast = j.radar?.nowcast ?? [];
    const past = j.radar?.past ?? [];
    // Prefer the latest *observed* frame (last entry in `past`) over the
    // first nowcast; users on a public alert page expect real data, not a
    // forecast extrapolation, when interpreting "current radar".
    const latest = past[past.length - 1] ?? nowcast[0];
    if (!host || !latest) return null;
    return { host, latest };
  } catch {
    return null;
  }
}

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

  // Pull the LibreWxR index on mount. Failure mode = no radar layer; the
  // polygon-on-basemap still renders so the page is never useless.
  const [lwxr, setLwxr] = useState<LwxrIndex | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchLwxrIndex(ctrl.signal).then(setLwxr);
    return () => ctrl.abort();
  }, []);

  const radarTileUrl = useMemo(() => {
    if (!lwxr) return null;
    return (
      `${lwxr.host}${lwxr.latest.path}/${LIBREWXR_TILE_SIZE}` +
      `/{z}/{x}/{y}/${LIBREWXR_COLOR}/${LIBREWXR_OPTS}.png`
    );
  }, [lwxr]);

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
        customAttribution='<a href="https://librewxr.net" target="_blank" rel="noopener noreferrer">© LibreWxR</a> (CC BY 4.0)'
      >
        {/* Polygon source/layers mount synchronously on first render. The
            radar layer below mounts AFTER the LibreWxR index fetch resolves,
            so without an explicit beforeId Mapbox stacks it on top of the
            polygon and hides the warning outline. */}
        <Source
          id="alert-polygon"
          type="geojson"
          data={{ type: 'Feature', geometry, properties: {} }}
        >
          <Layer
            id="alert-polygon-fill"
            type="fill"
            paint={{ 'fill-color': fill, 'fill-opacity': 0.18 }}
          />
          <Layer
            id="alert-polygon-line"
            type="line"
            paint={{ 'line-color': fill, 'line-width': 2.5 }}
          />
        </Source>
        {radarTileUrl ? (
          <Source
            id="alert-radar"
            type="raster"
            tiles={[radarTileUrl]}
            tileSize={LIBREWXR_TILE_SIZE}
            maxzoom={LIBREWXR_MAX_ZOOM}
          >
            <Layer
              id="alert-radar-layer"
              type="raster"
              paint={{ 'raster-opacity': 0.78 }}
              beforeId="alert-polygon-fill"
            />
          </Source>
        ) : null}
      </Map>
    </div>
  );
}
