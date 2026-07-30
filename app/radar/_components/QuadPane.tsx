'use client';

import { forwardRef } from 'react';
import Map, { Source, Layer, type MapRef } from 'react-map-gl';
import mapboxgl from 'mapbox-gl';
import type { Level2Overlay } from '../_hooks/useLevel2Data';

// One read-only pane of the 2×2 warn-ops quad. Renders its own basemap +
// a single Level II PNG overlay; the main map drives the camera imperatively
// (jumpTo fires no move events, so there's no feedback loop).

type Props = {
  styleUrl: string;
  token: string | null;
  initialViewState: { longitude: number; latitude: number; zoom: number };
  overlay: Level2Overlay | null;
  loading: boolean;
  label: string;
  site: string | null;
  opacity: number;
};

const QuadPane = forwardRef<MapRef, Props>(function QuadPane(
  { styleUrl, token, initialViewState, overlay, loading, label, site, opacity },
  ref,
) {
  return (
    <div className="relative min-h-0 min-w-0 border-l border-t border-wx-line">
      <Map
        ref={ref}
        initialViewState={initialViewState}
        dragPan={false}
        scrollZoom={false}
        dragRotate={false}
        doubleClickZoom={false}
        touchZoomRotate={false}
        boxZoom={false}
        keyboard={false}
        style={{ width: '100%', height: '100%' }}
        mapLib={mapboxgl as any}
        mapStyle={styleUrl}
        projection={{ name: 'mercator' } as any}
        mapboxAccessToken={token || undefined}
        attributionControl={false}
      >
        {overlay?.image_url && (
          <Source
            key={overlay.image_url}
            id={`quad-src-${label}`}
            type="image"
            url={overlay.image_url}
            coordinates={[
              [overlay.bounds.west, overlay.bounds.north],
              [overlay.bounds.east, overlay.bounds.north],
              [overlay.bounds.east, overlay.bounds.south],
              [overlay.bounds.west, overlay.bounds.south],
            ]}
          >
            <Layer
              id={`quad-layer-${label}`}
              type="raster"
              paint={{
                'raster-opacity': opacity,
                'raster-fade-duration': 120,
                'raster-resampling': 'nearest',
              }}
            />
          </Source>
        )}
      </Map>
      <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1.5 rounded bg-wx-card/95 border border-wx-line px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-wx-fg">
        {label}
        <span className="font-mono font-normal text-wx-mute">· {site ?? ''}</span>
        {loading ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-wx-accent" /> : null}
      </div>
      {overlay?.scan_time ? (
        <div className="absolute bottom-1.5 left-1.5 z-10 rounded bg-wx-card/80 px-1.5 py-0.5 font-mono text-[9px] text-wx-mute">
          {new Date(overlay.scan_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </div>
      ) : null}
    </div>
  );
});

export default QuadPane;
