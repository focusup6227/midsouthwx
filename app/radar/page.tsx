'use client';

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Map, { Source, Layer, type MapMouseEvent, type MapRef } from 'react-map-gl';
import mapboxgl from 'mapbox-gl';
import { supabaseBrowser } from '@/lib/supabase/client';
import Link from 'next/link';
import { mapboxAccessToken } from '@/lib/supabase/env';
import {
  CloudLightning, Radio, Wind, Atom, RotateCw, CloudSnow,
  Play, Pause, Trash2, Send, Circle, Target,
} from 'lucide-react';

// Three providers, picked per product based on which one actually publishes that
// product as a public tile feed:
//   - NOAA NCEP GeoServer (opengeo.ncep.noaa.gov) — composite + per-site reflectivity
//     and velocity. Same data as radar.weather.gov, transparent PNGs, CORS-friendly.
//   - UCAR THREDDS ncWMS (thredds.ucar.edu) — MRMS Az-Shear 0-2km AGL (the real low-
//     level rotation product). Composite-only; uses a timestamped GRIB2 dataset URL
//     that we resolve through our own /api/radar/mrms-latest proxy.
//   - Fly.io Level II renderer — single-site Correlation Coefficient (ρhv). IEM RIDGE
//     does not publish CC tiles; CC is proxied via /api/radar/level2 like Hi-Res refl/vel.
type ProductKey = 'composite' | 'reflectivity' | 'velocity' | 'correlation' | 'rotation' | 'ptype';

type ProductMeta = {
  label: string;
  short: string;
  modes: { composite: boolean; site: boolean };
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
};

const PRODUCTS: Record<ProductKey, ProductMeta> = {
  composite:    { label: 'Composite Reflectivity', short: 'CREF', modes: { composite: true,  site: false }, icon: CloudLightning },
  reflectivity: { label: 'Base Reflectivity',      short: 'BREF', modes: { composite: true,  site: true  }, icon: Radio },
  velocity:     { label: 'Base Velocity',          short: 'BVEL', modes: { composite: false, site: true  }, icon: Wind },
  correlation:  { label: 'Correlation Coeff',      short: 'CC',   modes: { composite: false, site: true  }, icon: Atom },
  rotation:     { label: 'Rotation (Az-Shear)',    short: 'ROT',  modes: { composite: true,  site: false }, icon: RotateCw },
  ptype:        { label: 'Precip Type',            short: 'PTYP', modes: { composite: true,  site: false }, icon: CloudSnow },
};

const NCEP_WMS_URL = (workspace: string, layer: string, cacheKey: number) =>
  `https://opengeo.ncep.noaa.gov/geoserver/${workspace}/ows` +
  `?service=WMS&request=GetMap&version=1.3.0` +
  `&layers=${encodeURIComponent(layer)}&styles=` +
  `&format=image/png&transparent=true` +
  `&width=256&height=256&crs=EPSG:3857` +
  `&bbox={bbox-epsg-3857}` +
  `&_t=${cacheKey}`;

const THREDDS_WMS_URL = (urlPath: string, layer: string, cacheKey: number) =>
  `https://thredds.ucar.edu/thredds/wms/${urlPath}` +
  `?service=WMS&request=GetMap&version=1.3.0` +
  `&layers=${encodeURIComponent(layer)}&styles=raster%2Fdefault` +
  `&format=image/png&transparent=true` +
  `&width=256&height=256&crs=EPSG:3857` +
  `&bbox={bbox-epsg-3857}` +
  `&_t=${cacheKey}`;

const RADAR_SITES: Record<string, { name: string; center: [number, number]; zoom: number }> = {
  KNQA: { name: 'KNQA Memphis', center: [-90.02, 35.05], zoom: 7.5 },
  KGWX: { name: 'KGWX Columbus', center: [-88.33, 33.9], zoom: 7.5 },
  KMRX: { name: 'KMRX Morristown', center: [-83.4, 36.17], zoom: 7.5 },
  KOHX: { name: 'KOHX Nashville', center: [-86.56, 36.25], zoom: 7.5 },
  KHTX: { name: 'KHTX Huntsville', center: [-86.08, 34.93], zoom: 7.5 },
  KLZK: { name: 'KLZK Little Rock', center: [-92.26, 34.84], zoom: 7.5 },
  KFFC: { name: 'KFFC Atlanta', center: [-84.57, 33.36], zoom: 7.5 },
  KTLH: { name: 'KTLH Tallahassee', center: [-84.3, 30.4], zoom: 7.5 },
};

type Selection = {
  type: 'circle';
  center: [number, number];
  radius_km: number;
} | {
  type: 'polygon';
  coordinates: number[][]; // [lon, lat] ring (closed)
};

type SweepInfo = { index: number; elevation_deg: number };

type Level2Overlay = {
  geojson_url: string;
  bounds: { north: number; south: number; east: number; west: number };
  scan_time: string;
  cached: boolean;
  render_ms?: number;
  available_sweeps: SweepInfo[];
  sweep_index: number | null;
  feature_count: number | null;
  vmin: number;
  vmax: number;
};

// Hex color stops, mirrored from the renderer's NWS palettes. Values are in
// the natural product units (dBZ, m/s, ρ); we convert each to the quantized
// `v` ∈ [0, 255] property carried on each polygon when building the Mapbox
// `interpolate` expression, so the colors match the PNG path pixel-for-pixel.
const REFL_STOPS: [number, string][] = [
  [-30, '#646464'], [5, '#04E9E7'], [10, '#019FF4'], [15, '#0300F4'],
  [20, '#02FD02'], [25, '#01C501'], [30, '#008E00'], [35, '#FDF802'],
  [40, '#E5BC00'], [45, '#FD9500'], [50, '#FD0000'], [55, '#D40000'],
  [60, '#BC0000'], [65, '#F800FD'], [70, '#9854C6'], [75, '#FDFDFD'],
  [80, '#FDFDFD'],
];
const VEL_STOPS: [number, string][] = [
  [-50, '#015B0E'], [-30, '#02C50A'], [-10, '#7FF87F'],
  [0, '#404040'],
  [10, '#FE7F7F'], [30, '#FE0000'], [50, '#7E0000'],
];
const CC_STOPS: [number, string][] = [
  [0.20, '#1f2937'], [0.50, '#6b7280'], [0.80, '#fbbf24'],
  [0.95, '#f59e0b'], [1.00, '#ef4444'], [1.05, '#dc2626'],
];

function buildFillColorExpr(product: 'refl' | 'vel' | 'cc', vmin: number, vmax: number): any {
  const stops = product === 'refl' ? REFL_STOPS : product === 'vel' ? VEL_STOPS : CC_STOPS;
  const range = vmax - vmin || 1;
  // De-dupe quantized stops with identical q (Mapbox requires strictly
  // increasing input stops); when two natural-unit stops collapse to the
  // same q we keep the latter color.
  const out: any[] = ['interpolate', ['linear'], ['get', 'v']];
  let lastQ = -Infinity;
  for (const [val, hex] of stops) {
    let q = ((val - vmin) / range) * 255;
    q = Math.max(0, Math.min(255, q));
    if (q <= lastQ) q = lastQ + 0.001;
    out.push(q, hex);
    lastQ = q;
  }
  return out;
}

function buildFillOpacityExpr(product: 'refl' | 'vel' | 'cc', userOpacity: number,
                              vmin: number, vmax: number): any {
  if (product !== 'refl') return userOpacity;
  // Reflectivity gates < 10 dBZ are filtered server-side. Ramp alpha from
  // 0.4 at 10 dBZ → 1.0 at 25 dBZ so weak/moderate echoes fade in cleanly
  // and severe cores read at full opacity.
  const range = vmax - vmin || 1;
  const q10 = ((10 - vmin) / range) * 255;
  const q25 = ((25 - vmin) / range) * 255;
  return [
    'interpolate', ['linear'], ['get', 'v'],
    q10, 0.4 * userOpacity,
    q25, userOpacity,
  ];
}

function formatElev(deg: number): string {
  return `${deg.toFixed(deg < 10 ? 1 : 0)}°`;
}

type NwsWarning = {
  id: string;
  nws_id: string;
  type: 'tornado' | 'severe' | 'flood' | 'other';
  event: string;
  label: string;
  area_desc: string | null;
  expires_at: string | null;
  centroid: [number, number];
  geometry: any;
};

type AudienceBreakdown = { memphis: number; tn: number; ms: number };

const TIMELINE_FRAMES = 18; // 12 observed + 6 forecast
const OBSERVED_COUNT = 12;
const FRAME_INTERVAL_MIN = 5;

export default function RadarPage() {
  const [subsGeo, setSubsGeo] = useState<any>({ type: 'FeatureCollection', features: [] });
  const [product, setProduct] = useState<ProductKey>('composite');
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [hiRes, setHiRes] = useState(false);
  // Tilt picker: 'composite' = max across all sweeps, otherwise the desired
  // elevation in degrees. We pick the closest matching sweep from the
  // volume's available_sweeps list (NEXRAD VCPs vary scan-to-scan), and the
  // UI then labels it with the actual angle of the rendered sweep.
  const [selectedElevation, setSelectedElevation] = useState<number | 'composite'>(0.5);
  const [level2Loading, setLevel2Loading] = useState(false);
  const [level2Error, setLevel2Error] = useState<string | null>(null);
  const [level2Overlay, setLevel2Overlay] = useState<Level2Overlay | null>(null);
  // Parsed GeoJSON FeatureCollection (Supabase Storage URL is fetched after
  // the renderer responds). Held separately from level2Overlay so we can
  // diff: changing only the user's opacity/color shouldn't trigger a refetch.
  const [level2GeoJSON, setLevel2GeoJSON] = useState<any>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ lng: number; lat: number; props: any } | null>(null);
  const [drawMode, setDrawMode] = useState<'none' | 'circle-center' | 'circle-radius' | 'polygon'>('none');
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const [circleCenter, setCircleCenter] = useState<[number, number] | null>(null);
  // NCEP GeoServer regenerates radar PNGs every ~5 min. We bust the tile cache with a
  // monotonic key tied to the wall clock so Mapbox refetches fresh imagery on a timer.
  const [tileCacheKey, setTileCacheKey] = useState(() => Math.floor(Date.now() / 60_000));
  // THREDDS MRMS rotation file path; resolved via our own /api/radar/mrms-latest proxy
  // because UCAR doesn't send CORS headers. Refreshed every few minutes.
  const [mrmsUrlPath, setMrmsUrlPath] = useState<string | null>(null);

  // --- New state for redesigned radar page ---
  const [opacity, setOpacity] = useState(78);
  const [frame, setFrame] = useState(OBSERVED_COUNT - 1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<'0.5x' | '1x' | '2x' | '4x'>('1x');
  const [warnings, setWarnings] = useState<NwsWarning[]>([]);
  const [hoverPixel, setHoverPixel] = useState<{ lng: number; lat: number; sample?: number } | null>(null);
  const [hoverSub, setHoverSub] = useState<any | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [audienceBreakdown, setAudienceBreakdown] = useState<AudienceBreakdown>({ memphis: 0, tn: 0, ms: 0 });

  const mapCursor = drawMode !== 'none' ? 'crosshair' : 'grab';

  const [viewState, setViewState] = useState({
    longitude: -89.8,
    latitude: 35.0,
    zoom: 7,
  });

  const mapRef = useRef<MapRef>(null);
  const token = mapboxAccessToken();
  // ID of the first non-base layer in the loaded Mapbox style. We insert the radar
  // *before* this layer so roads, admin boundaries, and place labels render on top
  // of the radar instead of being covered by it.
  const [radarBeforeId, setRadarBeforeId] = useState<string | null>(null);

  // Set Mapbox access token for dark OSM style and vector layers
  useEffect(() => {
    if (token) {
      mapboxgl.accessToken = token;
    }
  }, [token]);

  // Find the first symbol layer in the style and insert the radar *just below
  // it*. Symbol layers are where Mapbox renders text and icons (city labels,
  // road labels, POIs, admin labels), so this "sandwiches" the radar between
  // the basemap geometry (water/roads/landuse) and the labels — exactly what
  // we want: radar visually covers terrain and roads, but city names stay
  // legible on top. Idempotent: onStyleData fires repeatedly, we resolve once.
  const resolvedBeforeIdRef = useRef<string | null>(null);
  const handleMapLoad = useCallback(() => {
    if (resolvedBeforeIdRef.current) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layers = map.getStyle()?.layers ?? [];
    const firstSymbol = layers.find((l: any) => l.type === 'symbol');
    if (firstSymbol) {
      resolvedBeforeIdRef.current = firstSymbol.id;
      setRadarBeforeId(firstSymbol.id);
    }
  }, []);

  // Load subscriber GeoJSON from server (uses ST_AsGeoJSON via reliable query)
  useEffect(() => {
    fetch('/api/radar/subs')
      .then((r) => r.json())
      .then((geo) => setSubsGeo(geo || { type: 'FeatureCollection', features: [] }))
      .catch(() => {});
  }, []);

  // Refresh radar pixels every minute by bumping the cache key (which appears as `&_t=`
  // on every WMS request). NEXRAD scans every 4-10 min so 60s is plenty fresh.
  useEffect(() => {
    const id = setInterval(() => setTileCacheKey(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(id);
  }, []);

  // Resolve the latest MRMS RotationTrack GRIB2 file path through our proxy. Files
  // are published every 10 min — refresh every 3 min so we pick up new data quickly
  // without spamming the upstream THREDDS server.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/radar/mrms-latest', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j?.urlPath) setMrmsUrlPath(j.urlPath);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 180_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Load active NWS warnings for the Mid-South region (for chips + inspector list)
  useEffect(() => {
    fetch('/api/radar/warnings')
      .then((r) => r.json())
      .then((j) => setWarnings(j?.warnings ?? []))
      .catch(() => {});
  }, []);

  // Coerce invalid product/mode combos back to a sane default rather than render broken
  // URLs. e.g. "rotation" only exists in composite mode; "velocity" only in site mode.
  const effectiveProduct: ProductKey = useMemo(() => {
    const meta = PRODUCTS[product];
    if (selectedSite && !meta.modes.site) return 'reflectivity';
    if (!selectedSite && !meta.modes.composite) return 'composite';
    return product;
  }, [product, selectedSite]);

  // Level II renderer: CC always; refl/vel when Hi-Res is on (no public CC tile feed exists).
  const level2Product =
    effectiveProduct === 'velocity' ? 'vel'
    : effectiveProduct === 'correlation' ? 'cc'
    : 'refl';
  const useLevel2 = !!selectedSite && (
    effectiveProduct === 'correlation'
    || (hiRes && (effectiveProduct === 'reflectivity' || effectiveProduct === 'velocity'))
  );

  const selectProduct = useCallback((k: ProductKey) => {
    const meta = PRODUCTS[k];
    if (!selectedSite && meta.modes.site && !meta.modes.composite) {
      const defaultSite = 'KNQA';
      const site = RADAR_SITES[defaultSite];
      setSelectedSite(defaultSite);
      mapRef.current?.flyTo({ center: site.center, zoom: site.zoom, duration: 700 });
    }
    setProduct(k);
  }, [selectedSite]);

  // Resolve "elevation requested" → "sweep index in current volume" by
  // nearest-neighbor over available_sweeps. Returns 0 before metadata
  // arrives (first fetch), then locks onto whatever the user picked.
  const availableSweeps = level2Overlay?.available_sweeps ?? [];
  const isComposite = selectedElevation === 'composite';
  const resolvedSweepIndex = useMemo(() => {
    if (isComposite) return 0;
    if (!availableSweeps.length) return 0;
    let best = 0, bestDiff = Infinity;
    for (const s of availableSweeps) {
      const d = Math.abs(s.elevation_deg - (selectedElevation as number));
      if (d < bestDiff) { bestDiff = d; best = s.index; }
    }
    return best;
  }, [availableSweeps, selectedElevation, isComposite]);

  useEffect(() => {
    if (!useLevel2 || !selectedSite) {
      setLevel2Overlay(null);
      setLevel2GeoJSON(null);
      setLevel2Error(null);
      setLevel2Loading(false);
      return;
    }

    let cancelled = false;
    setLevel2GeoJSON(null);
    setLevel2Error(null);

    // Up to 4 attempts with increasing backoff to tolerate Fly cold starts.
    // Per-tilt renders also miss the cache the first time → same retry budget.
    const RETRY_DELAYS = [4000, 8000, 12000];

    const load = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      setLevel2Loading(true);

      try {
        const url = `/api/radar/level2/${selectedSite}`
          + `?product=${level2Product}`
          + `&format=geojson`
          + `&sweep_index=${resolvedSweepIndex}`
          + (isComposite ? '&composite=1' : '');
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;

        if (data.error) {
          if (attempt < RETRY_DELAYS.length) {
            setLevel2Error('renderer_waking');
            setTimeout(() => { if (!cancelled) load(attempt + 1); }, RETRY_DELAYS[attempt]);
            return;
          }
          setLevel2Error(data.error);
          setLevel2Overlay(null);
          setLevel2GeoJSON(null);
          return;
        }

        // Surface metadata (available sweeps, bounds, scan_time) immediately
        // so the tilt picker and legend can update before the GeoJSON itself
        // finishes downloading.
        setLevel2Overlay(data as Level2Overlay);
        setLevel2Error(null);

        // Second hop: download the GeoJSON payload from Supabase Storage.
        // We store it gzipped (Content-Encoding: gzip on upload) — Cloudflare
        // in front of Supabase Storage doesn't echo that encoding header
        // back to the client, so the browser receives the raw gzip blob and
        // we have to decompress it ourselves via DecompressionStream. This
        // keeps the on-wire payload at ~600 KB-2 MB rather than ~10-40 MB.
        if (!data.geojson_url) throw new Error('renderer returned no geojson_url');
        const gjRes = await fetch(data.geojson_url, { cache: 'default' });
        if (!gjRes.ok) throw new Error(`geojson fetch ${gjRes.status}`);
        if (!gjRes.body) throw new Error('geojson response has no body');
        const decompressed = gjRes.body.pipeThrough(new DecompressionStream('gzip'));
        const text = await new Response(decompressed).text();
        const gj = JSON.parse(text);
        if (cancelled) return;
        setLevel2GeoJSON(gj);
      } catch (err) {
        if (cancelled) return;
        if (attempt < RETRY_DELAYS.length) {
          setLevel2Error('renderer_waking');
          setTimeout(() => { if (!cancelled) load(attempt + 1); }, RETRY_DELAYS[attempt]);
          return;
        }
        setLevel2Error('renderer_unreachable');
        setLevel2GeoJSON(null);
      } finally {
        if (!cancelled) setLevel2Loading(false);
      }
    };

    load();
    // Auto-refresh every 5 min for the latest scan.
    const id = setInterval(() => load(0), 300_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [useLevel2, selectedSite, level2Product, resolvedSweepIndex, isComposite]);

  const radarSourceId = 'radar-source';
  const radarLayerId = 'radar-layer';
  const level2SourceId = 'level2-image';

  // Build the actual tile URL for the active product/mode combination.
  // Returns `null` when the combo isn't currently renderable (e.g. rotation selected
  // but MRMS dataset path hasn't loaded yet) so we can drop the source entirely.
  const tileUrl: string | null = useMemo(() => {
    if (selectedSite) {
      const site = selectedSite.toLowerCase();
      switch (effectiveProduct) {
        case 'reflectivity':
          return NCEP_WMS_URL(site, `${site}:${site}_sr_bref`, tileCacheKey);
        case 'velocity':
          return NCEP_WMS_URL(site, `${site}:${site}_sr_bvel`, tileCacheKey);
        case 'correlation':
          // CC is rendered from Level II via the Fly.io renderer (see useLevel2).
          return null;
        default:
          return null;
      }
    }
    switch (effectiveProduct) {
      case 'composite':
        return NCEP_WMS_URL('conus', 'conus:conus_cref_qcd', tileCacheKey);
      case 'reflectivity':
        return NCEP_WMS_URL('conus', 'conus:conus_bref_qcd', tileCacheKey);
      case 'rotation':
        if (!mrmsUrlPath) return null;
        return THREDDS_WMS_URL(
          mrmsUrlPath,
          'MergedAzShear0to2kmAGL_altitude_above_msl',
          tileCacheKey,
        );
      default:
        return null;
    }
  }, [effectiveProduct, selectedSite, tileCacheKey, mrmsUrlPath]);

  // Stable key forces <Source> to remount when the tile URL pattern changes — avoids the
  // "Unable to update <Source> prop: tiles" warning when switching layers/sites.
  const radarSourceKey = useMemo(() => {
    const base = selectedSite ? `site:${selectedSite.toLowerCase()}` : 'conus';
    return `${base}:${effectiveProduct}:${mrmsUrlPath ?? '-'}:${tileCacheKey}`;
  }, [selectedSite, effectiveProduct, tileCacheKey, mrmsUrlPath]);

  const radarSource = useMemo(() => {
    // Keep free tiles visible under Hi-Res — Level II PNGs are often mostly
    // transparent in clear air; hiding NCEP made the map look empty.
    if (!tileUrl) return null;
    return {
      type: 'raster' as const,
      tiles: [tileUrl],
      tileSize: 256,
    };
  }, [tileUrl]);

  // GeoJSON source carrying ~30-80k polar wedge polygons. Mapbox rasterizes
  // them client-side at native screen resolution, so curvature stays crisp
  // at any zoom — no PNG aliasing or pixel quilt.
  const level2GeoJSONSource = useMemo(() => {
    if (!useLevel2 || !level2GeoJSON) return null;
    return { type: 'geojson' as const, data: level2GeoJSON };
  }, [useLevel2, level2GeoJSON]);

  const radarLayer = {
    id: radarLayerId,
    type: 'raster' as const,
    source: radarSourceId,
    paint: {
      'raster-opacity': opacity / 100,
      'raster-fade-duration': 0,
      // Nearest for crisp, faithful gate edges (target RadarScope-style look).
      // CRITICAL: nearest also means partial alpha in the source PNG is read
      // 1:1, no bilinear mixing of alphas → safe to use a graduated alpha
      // ramp for low echoes without re-introducing the patchwork-quilt
      // artifact we eliminated earlier.
      'raster-resampling': 'nearest' as const,
    },
    ...(radarBeforeId ? { beforeId: radarBeforeId } : {}),
  };

  const level2Layer = {
    id: 'level2-fill',
    type: 'fill' as const,
    source: level2SourceId,
    paint: {
      'fill-color': level2Overlay
        ? buildFillColorExpr(level2Product, level2Overlay.vmin, level2Overlay.vmax)
        : '#000000',
      'fill-opacity': level2Overlay
        ? buildFillOpacityExpr(level2Product, opacity / 100,
                               level2Overlay.vmin, level2Overlay.vmax)
        : 0,
      // Antialiased polygon edges look better than the raster path's
      // pixelated stair-steps at every zoom — true RadarScope/WeatherWise
      // feel, since these are real vector wedges now.
      'fill-antialias': true,
    },
    ...(radarBeforeId ? { beforeId: radarBeforeId } : {}),
  };

  // Subscriber GeoJSON from server (already in correct format)
  const subsGeoJSON = subsGeo;

  // Cyan glow halo + pin (matches design spec)
  const subsHaloLayer: any = {
    id: 'subs-halo',
    type: 'circle' as const,
    source: 'subs-source',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 8, 8, 12, 14],
      'circle-color': '#38bdf8',
      'circle-opacity': 0.18,
      'circle-blur': 0.6,
    },
  };
  const subsPinLayer: any = {
    id: 'subs-pin',
    type: 'circle' as const,
    source: 'subs-source',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 8, 3, 12, 5],
      'circle-color': '#38bdf8',
      'circle-stroke-color': '#0b1220',
      'circle-stroke-width': 1.2,
    },
  };

  const handleMapClick = (e: MapMouseEvent) => {
    // Prevent map panning/zoom when in draw mode
    if (drawMode !== 'none' && e.originalEvent) {
      e.originalEvent.stopPropagation();
      e.originalEvent.preventDefault?.();
    }
    const { lng, lat } = e.lngLat;

    if (drawMode === 'circle-center') {
      setCircleCenter([lng, lat]);
      setDrawMode('circle-radius');
      setSelection(null);
      setPreviewCount(null);
    } else if (drawMode === 'circle-radius' && circleCenter) {
      // compute radius using haversine (no dep)
      const toRad = (d: number) => (d * Math.PI) / 180;
      const R = 6371; // km
      const dLat = toRad(lat - circleCenter[1]);
      const dLon = toRad(lng - circleCenter[0]);
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(circleCenter[1])) * Math.cos(toRad(lat)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distKm = R * c;

      const newSel: Selection = { type: 'circle', center: circleCenter, radius_km: Math.max(1, Math.round(distKm * 10) / 10) };
      setSelection(newSel);
      setDrawMode('none');
      setCircleCenter(null);
      // trigger preview
      previewAudience(newSel);
    } else if (drawMode === 'polygon') {
      const pts = [...polygonPoints, [lng, lat] as [number, number]];
      setPolygonPoints(pts);
      if (pts.length >= 3) {
        // allow complete anytime after 3
      }
    }
  };

  const completePolygon = () => {
    if (polygonPoints.length < 3) return;
    // close the ring
    const ring = [...polygonPoints, polygonPoints[0]];
    const newSel: Selection = { type: 'polygon', coordinates: ring };
    setSelection(newSel);
    setDrawMode('none');
    setPolygonPoints([]);
    previewAudience(newSel);
  };

  const cancelDraw = () => {
    setDrawMode('none');
    setCircleCenter(null);
    setPolygonPoints([]);
    setSelection(null);
    setPreviewCount(null);
  };

  const startCircleDraw = () => {
    cancelDraw();
    setDrawMode('circle-center');
  };

  const startPolygonDraw = () => {
    cancelDraw();
    setDrawMode('polygon');
    setPolygonPoints([]);
  };

  // Preview count using the extended RPC
  const previewAudience = async (sel: Selection) => {
    const supa = supabaseBrowser();
    let spec: any = {};
    if (sel.type === 'circle') {
      spec = { geometry: { type: 'circle', center: sel.center, radius_km: sel.radius_km } };
    } else {
      spec = { geometry: { type: 'Polygon', coordinates: [sel.coordinates] } };
    }
    const { data, error } = await supa.rpc('resolve_audience', { spec });
    if (!error && data) {
      setPreviewCount(data.length);
    } else {
      setPreviewCount(0);
    }
  };

  const goToCompose = () => {
    if (!selection) return;
    // For now, serialize selection into query (simple) or localStorage; later compose integration
    // Pass via URL search for prefill (basic)
    const params = new URLSearchParams();
    if (selection.type === 'circle') {
      params.set('geo', JSON.stringify({ type: 'circle', center: selection.center, radius_km: selection.radius_km }));
    } else {
      params.set('geo', JSON.stringify({ type: 'polygon', coordinates: selection.coordinates }));
    }
    window.location.href = `/compose?${params.toString()}`;
  };

  // Playback loop for timeline
  useEffect(() => {
    if (!playing) return;
    const ms = { '0.5x': 800, '1x': 400, '2x': 220, '4x': 110 }[speed] ?? 400;
    const id = setInterval(() => {
      setFrame((f) => {
        const next = f + 1;
        return next >= TIMELINE_FRAMES ? 0 : next;
      });
    }, ms);
    return () => clearInterval(id);
  }, [playing, speed]);

  // Update opacity live on the radar layer
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (map && map.getLayer(radarLayerId)) {
      map.setPaintProperty(radarLayerId, 'raster-opacity', opacity / 100);
    }
  }, [opacity]);

  // Compute audience breakdown when selection changes (client-side enrichment from subs GeoJSON)
  useEffect(() => {
    if (!selection) {
      setAudienceBreakdown({ memphis: 0, tn: 0, ms: 0 });
      return;
    }
    const feats = subsGeo.features || [];
    let memphis = 0, tn = 0, ms = 0;
    for (const f of feats) {
      const [lng, lat] = f.geometry.coordinates;
      let hit = false;
      if (selection.type === 'circle') {
        const toRad = (d: number) => (d * Math.PI) / 180;
        const R = 6371;
        const dLat = toRad(lat - selection.center[1]);
        const dLon = toRad(lng - selection.center[0]);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(selection.center[1])) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        hit = R * c <= selection.radius_km;
      } else {
        // simple ray-cast for polygon
        const vs = selection.coordinates;
        let inside = false;
        for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
          const xi = vs[i][0], yi = vs[i][1], xj = vs[j][0], yj = vs[j][1];
          const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
          if (intersect) inside = !inside;
        }
        hit = inside;
      }
      if (!hit) continue;
      const city = (f.properties?.name || '').toLowerCase();
      if (city.includes('memphis') || city.includes('bartlett') || city.includes('lakeland')) memphis++;
      else if (city.includes('jackson') || city.includes('jonesboro') || city.includes('west memphis')) tn++;
      else ms++;
    }
    setAudienceBreakdown({ memphis, tn, ms });
  }, [selection, subsGeo]);

  // Helper: fly to a warning centroid
  const focusWarning = (w: NwsWarning) => {
    if (mapRef.current) {
      mapRef.current.flyTo({ center: w.centroid, zoom: 8.5, duration: 800 });
    }
  };

  // Radar site chips overlay positions (HTML, not Mapbox markers)
  const [mapPos, setMapPos] = useState({ w: 0, h: 0, k: 0 });
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const tick = () => setMapPos((p) => ({ w: map.getContainer().clientWidth, h: map.getContainer().clientHeight, k: p.k + 1 }));
    map.on('move', tick);
    map.on('resize', tick);
    tick();
    return () => { map.off('move', tick); map.off('resize', tick); };
  }, []);

  const screenPoint = (lngLat: [number, number]) => {
    const map = mapRef.current?.getMap();
    return map ? map.project(lngLat) : null;
  };

  // Build frame time label for timeline readout
  const frameTimeLabel = useMemo(() => {
    const now = new Date();
    const offsetMin = (frame - (OBSERVED_COUNT - 1)) * FRAME_INTERVAL_MIN;
    const d = new Date(now.getTime() + offsetMin * 60_000);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }, [frame]);

  const isForecastFrame = frame >= OBSERVED_COUNT;
  const relLabel = frame === OBSERVED_COUNT - 1 ? 'NOW' : (frame > OBSERVED_COUNT - 1 ? `+${(frame - (OBSERVED_COUNT - 1)) * FRAME_INTERVAL_MIN} min` : `−${Math.abs((frame - (OBSERVED_COUNT - 1)) * FRAME_INTERVAL_MIN)} min`);

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col bg-wx-ink text-wx-fg">
      {/* Topbar — 64px, in flow */}
      <div className="h-16 flex items-center justify-between px-6 border-b border-wx-line bg-wx-ink flex-shrink-0 z-30">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold tracking-[-0.01em]">Mid-South WX</span>
          <span className="text-sm text-wx-mute">/ Radar</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="pill inline-flex items-center gap-1.5 px-2.5 py-1 bg-wx-card border border-wx-line rounded-md text-[11px] text-wx-mute">
            <span className="wx-pulse" /> Live
          </div>
          <Link href="/dashboard" className="btn-ghost text-sm px-3 py-1.5">Dashboard</Link>
          <Link href="/compose" className="btn-ghost text-sm px-3 py-1.5">Compose</Link>
          <Link href="/nws" className="btn-ghost text-sm px-3 py-1.5">NWS</Link>
          <Link href="/inbox" className="btn-ghost text-sm px-3 py-1.5">Inbox</Link>
          <Link href="/subscribers" className="btn-ghost text-sm px-3 py-1.5">Subscribers</Link>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        <Map
          ref={mapRef}
          initialViewState={viewState}
          onMove={(e) => setViewState(e.viewState)}
          onLoad={handleMapLoad}
          onStyleData={handleMapLoad}
          style={{ width: '100%', height: '100%', cursor: mapCursor }}
          mapLib={mapboxgl as any}
          mapStyle="mapbox://styles/mapbox/dark-v11"
          mapboxAccessToken={token || undefined}
          dragPan={drawMode === 'none'}
          scrollZoom={drawMode === 'none'}
          dragRotate={false}
          touchZoomRotate={false}
          boxZoom={false}
          onClick={handleMapClick}
          onMouseMove={(e) => {
            const { lng, lat } = e.lngLat;
            setHoverPixel({ lng, lat });

            // subscriber hover (custom HTML tooltip)
            const near = subsGeo.features?.find((f: any) => {
              const [sx, sy] = f.geometry.coordinates;
              return Math.hypot(sx - lng, sy - lat) < 0.04;
            });
            if (near) {
              const p = mapRef.current?.getMap()?.project([lng, lat]);
              if (p) setHoverPos({ x: p.x, y: p.y });
              setHoverSub(near.properties);
            } else {
              setHoverSub(null);
            }
          }}
          onMouseLeave={() => {
            setHoverPixel(null);
            setHoverSub(null);
          }}
        >
          {/* Radar tiles */}
          {radarSource && (
            <Source key={radarSourceKey} id={radarSourceId} {...radarSource}>
              <Layer {...radarLayer} />
            </Source>
          )}

          {/* Level II hi-res overlay — client-side polar polygons */}
          {level2GeoJSONSource && (
            <Source
              key={`level2:${selectedSite}:${level2Product}:${level2Overlay?.scan_time}:${resolvedSweepIndex}:${isComposite ? 'c' : 'b'}`}
              id={level2SourceId}
              {...level2GeoJSONSource}
            >
              <Layer {...level2Layer} />
            </Source>
          )}

          {/* Subscribers — cyan glow halo + pin */}
          <Source id="subs-source" type="geojson" data={subsGeoJSON}>
            <Layer {...subsHaloLayer} />
            <Layer {...subsPinLayer} />
          </Source>

          {/* Selection visualization (amber per design) */}
          {selection && selection.type === 'circle' && (
            <Source id="selection-circle" type="geojson" data={{ type: 'Feature', geometry: { type: 'Point', coordinates: selection.center }, properties: {} }}>
              <Layer id="sel-circle" type="circle" paint={{
                'circle-radius': (selection.radius_km / 111) * 1000 * (viewState.zoom / 8),
                'circle-color': 'rgba(251,191,36,0.15)',
                'circle-stroke-color': '#fbbf24',
                'circle-stroke-width': 2,
              }} />
            </Source>
          )}
          {selection && selection.type === 'polygon' && (
            <Source id="selection-poly" type="geojson" data={{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [selection.coordinates] }, properties: {} }}>
              <Layer id="sel-poly-fill" type="fill" paint={{ 'fill-color': '#fbbf24', 'fill-opacity': 0.12 }} />
              <Layer id="sel-poly-line" type="line" paint={{ 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [2, 1] }} />
            </Source>
          )}

          {/* Live polygon draw vertices */}
          {drawMode === 'polygon' && polygonPoints.length > 0 && (
            <Source id="poly-draw" type="geojson" data={{ type: 'Feature', geometry: { type: 'LineString', coordinates: polygonPoints }, properties: {} }}>
              <Layer id="poly-line" type="line" paint={{ 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [2, 1] }} />
            </Source>
          )}
        </Map>

        {/* Products rail (left) */}
        <div className="products-rail absolute top-4 left-4 w-[68px] bg-wx-card border border-wx-line rounded-xl p-1.5 flex flex-col gap-0.5 z-20">
          {(Object.keys(PRODUCTS) as ProductKey[]).map((k, idx) => {
            const p = PRODUCTS[k];
            const Icon = p.icon;
            const allowed = selectedSite ? p.modes.site : p.modes.composite;
            const disabled = !allowed || (k === 'rotation' && !mrmsUrlPath);
            const active = effectiveProduct === k;
            return (
              <React.Fragment key={k}>
                {idx === 5 && <div className="h-px bg-wx-line my-1 mx-2" />}
                <button
                  onClick={() => !disabled && selectProduct(k)}
                  disabled={disabled}
                  title={disabled ? (selectedSite ? 'Not available in single-site mode' : 'Pick a radar site below to use this product') : p.label}
                  className={`prod-btn flex flex-col items-center justify-center gap-0.5 py-2 rounded-lg text-[10px] font-semibold tracking-wide transition ${active ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'text-wx-mute hover:text-wx-fg'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <Icon size={20} className={active ? 'text-wx-accent' : ''} />
                  <span>{p.short}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Draw toolbar */}
        <div className="draw-tools absolute top-4 left-[100px] flex gap-2 items-center z-20">
          <button onClick={startCircleDraw} className={`draw-btn px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm flex items-center gap-1.5 ${drawMode.includes('circle') ? 'active bg-wx-accent text-black border-wx-accent' : ''}`}>
            <Circle size={14} /> Circle
          </button>
          <button onClick={startPolygonDraw} className={`draw-btn px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm flex items-center gap-1.5 ${drawMode === 'polygon' ? 'active bg-wx-accent text-black border-wx-accent' : ''}`}>
            <Target size={14} /> Polygon
          </button>
          {drawMode === 'polygon' && (
            <button onClick={completePolygon} disabled={polygonPoints.length < 3} className="draw-btn px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm disabled:opacity-50">Complete ({polygonPoints.length})</button>
          )}
          {(drawMode !== 'none' || selection) && (
            <button onClick={cancelDraw} className="draw-btn px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm text-wx-mute hover:text-wx-danger hover:border-wx-danger flex items-center gap-1.5">
              <Trash2 size={14} /> Clear
            </button>
          )}
          {drawMode === 'circle-center' && <div className="pill text-[11px]"><span className="kbd px-1.5 py-0.5 text-[10px] border border-wx-line rounded bg-wx-ink">Click</span> set center</div>}
          {drawMode === 'circle-radius' && <div className="pill text-[11px]"><span className="kbd px-1.5 py-0.5 text-[10px] border border-wx-line rounded bg-wx-ink">Click</span> set radius</div>}
          {drawMode === 'polygon' && polygonPoints.length === 0 && <div className="pill text-[11px]"><span className="kbd px-1.5 py-0.5 text-[10px] border border-wx-line rounded bg-wx-ink">Click</span> add vertex</div>}
        </div>

        {/* Warning chips (second row) */}
        {warnings.length > 0 && (
          <div className="warnings-strip absolute top-16 left-[100px] flex flex-wrap gap-2 max-w-[calc(100%-100px-340px)] z-10">
            {warnings.slice(0, 6).map((w) => (
              <button key={w.id} onClick={() => focusWarning(w)} className={`warning-chip inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium ${w.type === 'tornado' ? 'border-red-500/50 text-red-300' : w.type === 'severe' ? 'border-orange-500/50 text-orange-300' : 'border-emerald-500/50 text-emerald-300'}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" /> {w.label}
              </button>
            ))}
          </div>
        )}

        {/* Inspector (right) */}
        {!selection && (
          <div className="inspector absolute top-4 right-4 w-[304px] max-h-[calc(100%-220px)] overflow-y-auto p-4 bg-wx-card border border-wx-line rounded-xl flex flex-col gap-[18px] z-20 wx-scroll">
            {/* Legend */}
            <div>
              <div className="flex items-center justify-between text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                <span>Legend · {PRODUCTS[effectiveProduct].short}</span>
                <span className="font-mono text-[10px] text-wx-mute">
                  {(() => {
                    if (effectiveProduct === 'rotation') return 'MRMS · CONUS';
                    if (useLevel2) {
                      const tiltLabel = isComposite
                        ? 'COMP'
                        : (() => {
                            const s = availableSweeps.find((x) => x.index === resolvedSweepIndex);
                            return s ? formatElev(s.elevation_deg) : '—';
                          })();
                      if (effectiveProduct === 'correlation') return `Level II · ρhv · ${tiltLabel}`;
                      return `Level II · ${tiltLabel}`;
                    }
                    return selectedSite ? 'Single-site' : 'CONUS · QCD';
                  })()}
                </span>
              </div>
              {effectiveProduct === 'correlation' && selectedSite && (
                <p className="text-[10px] text-wx-mute mt-1">
                  {level2Loading ? 'Rendering correlation coefficient…'
                    : level2Error === 'renderer_not_configured' ? 'Renderer not configured (see .env.local)'
                    : level2Error === 'renderer_waking' ? 'Renderer waking up…'
                    : (level2Error === 'renderer_unreachable' || level2Error === 'renderer_timeout') ? 'Renderer slow — retrying…'
                    : level2Error ? `CC unavailable (${level2Error})`
                    : level2Overlay ? `Scan ${new Date(level2Overlay.scan_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} UTC`
                    : 'Waiting for Level II render…'}
                </p>
              )}
              <div className={`h-2.5 rounded-[3px] mt-1 ${effectiveProduct === 'velocity' ? 'bg-[linear-gradient(90deg,#16a34a_0%,#22d3ee_25%,#e5e7eb_50%,#fb7185_75%,#b91c1c_100%)]' : effectiveProduct === 'rotation' ? 'bg-[linear-gradient(90deg,#1e1b4b_0%,#6d28d9_40%,#d946ef_70%,#fde047_100%)]' : effectiveProduct === 'correlation' ? 'bg-[linear-gradient(90deg,#1f2937_0%,#4b5563_30%,#6b7280_60%,#fbbf24_85%,#ef4444_100%)]' : 'bg-[linear-gradient(90deg,#3b82f6_0%,#22d3ee_15%,#10b981_30%,#84cc16_45%,#facc15_60%,#f97316_75%,#ef4444_88%,#d946ef_100%)]'}`} />
              <div className="flex justify-between text-[9.5px] font-mono text-wx-mute mt-1">
                {effectiveProduct === 'velocity' && ['−64', '−32', '0', '+32', '+64 kts'].map(t => <span key={t}>{t}</span>)}
                {effectiveProduct === 'rotation' && ['0', '0.005', '0.010', '0.015', '0.020 s⁻¹'].map(t => <span key={t}>{t}</span>)}
                {effectiveProduct === 'correlation' && ['0.2', '0.5', '0.8', '0.95', '1.0'].map(t => <span key={t}>{t}</span>)}
                {(effectiveProduct === 'composite' || effectiveProduct === 'reflectivity' || effectiveProduct === 'ptype') && ['5', '15', '25', '35', '45', '55', '65', '75 dBZ'].map(t => <span key={t}>{t}</span>)}
              </div>
            </div>

            {/* Opacity */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="panel-title text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Layer opacity</span>
                <span className="font-mono text-[11px] text-wx-fg">{opacity}%</span>
              </div>
              <input type="range" min={20} max={100} step={2} value={opacity} onChange={(e) => setOpacity(parseInt(e.target.value))} className="wx-slider" />
            </div>

            {/* Mode + sites */}
            <div>
              <div className="panel-title text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Mode</div>
              <div className="flex border border-wx-line rounded-lg overflow-hidden bg-wx-ink">
                <button onClick={() => setSelectedSite(null)} className={`flex-1 py-1.5 text-sm font-medium ${!selectedSite ? 'bg-wx-card text-wx-fg' : 'text-wx-mute'}`}>CONUS</button>
                <button onClick={() => { if (!selectedSite) { setSelectedSite('KNQA'); mapRef.current?.flyTo({ center: RADAR_SITES.KNQA.center, zoom: 8, duration: 700 }); } }} className={`flex-1 py-1.5 text-sm font-medium border-l border-wx-line ${selectedSite ? 'bg-wx-card text-wx-fg' : 'text-wx-mute'}`}>Single site</button>
              </div>
              {selectedSite && (
                <div className="grid grid-cols-2 gap-1 mt-1.5">
                  {Object.keys(RADAR_SITES).map((code) => (
                    <button key={code} onClick={() => { const s = RADAR_SITES[code]; mapRef.current?.flyTo({ center: s.center, zoom: s.zoom, duration: 700 }); setSelectedSite(code); }} className={`text-left px-2.5 py-1 rounded text-[11px] ${selectedSite === code ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'hover:bg-wx-ink/50 text-wx-mute'}`}>
                      <div className="font-mono text-[10px] text-wx-accent">{code}</div>
                      <div>{RADAR_SITES[code].name.split(' ').slice(1).join(' ')}</div>
                    </button>
                  ))}
                </div>
              )}
              {/* Hi-Res toggle — only for Single-site reflectivity or velocity */}
              {selectedSite && (effectiveProduct === 'reflectivity' || effectiveProduct === 'velocity') && (
                <div className="pt-3 border-t border-wx-line mt-1">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Hi-Res Level II</div>
                      <div className="text-[10px] text-wx-mute">Sharper single-site render</div>
                    </div>
                    <button
                      onClick={() => setHiRes(!hiRes)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${hiRes ? 'bg-wx-accent' : 'bg-wx-line'}`}
                      aria-pressed={hiRes}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${hiRes ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                    </button>
                  </label>
                  {/* Tilt picker. Available elevations come from the
                      volume's metadata, so VCP changes (severe vs clear
                      air) update the list automatically. Composite is
                      one option in the same list rather than a separate
                      toggle. */}
                  {hiRes && (
                    <div className="mt-2.5 pt-2.5 border-t border-wx-line/40">
                      <div className="flex items-center justify-between">
                        <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Tilt</div>
                        <span className="font-mono text-[10px] text-wx-mute">
                          {(() => {
                            if (isComposite) return 'COMPOSITE';
                            const s = availableSweeps.find((x) => x.index === resolvedSweepIndex);
                            return s ? formatElev(s.elevation_deg) : '—';
                          })()}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-1 mt-1.5">
                        {/* User-facing tilt choices. We snap to the
                            closest available sweep when the actual
                            NEXRAD VCP differs. */}
                        {[0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0].map((deg) => {
                          const active = !isComposite && selectedElevation === deg;
                          const haveData = availableSweeps.length > 0;
                          const nearest = haveData
                            ? availableSweeps.reduce((best, s) =>
                                Math.abs(s.elevation_deg - deg) < Math.abs(best.elevation_deg - deg) ? s : best)
                            : null;
                          return (
                            <button
                              key={deg}
                              onClick={() => setSelectedElevation(deg)}
                              className={`px-1.5 py-1 rounded text-[10px] font-mono border transition ${
                                active
                                  ? 'bg-wx-accent text-black border-wx-accent'
                                  : 'bg-wx-ink border-wx-line text-wx-mute hover:text-wx-fg'
                              }`}
                              title={nearest ? `nearest sweep: ${formatElev(nearest.elevation_deg)} (idx ${nearest.index})` : 'awaiting volume metadata'}
                            >
                              {formatElev(deg)}
                            </button>
                          );
                        })}
                        <button
                          onClick={() => setSelectedElevation('composite')}
                          className={`col-span-4 px-1.5 py-1 rounded text-[10px] font-mono border transition ${
                            isComposite
                              ? 'bg-wx-accent text-black border-wx-accent'
                              : 'bg-wx-ink border-wx-line text-wx-mute hover:text-wx-fg'
                          }`}
                          title="Max reflectivity across all tilts — surfaces elevated storm cores"
                        >
                          COMPOSITE · ALL TILTS
                        </button>
                      </div>
                    </div>
                  )}
                  {hiRes && level2Loading && (
                    <p className="text-[10px] text-wx-mute mt-1">Rendering…</p>
                  )}
                  {hiRes && level2Error === 'renderer_not_configured' && (
                    <p className="text-[10px] text-wx-danger mt-1">Renderer not configured — set RENDERER_BASE_URL and RENDERER_TOKEN</p>
                  )}
                  {hiRes && level2Error === 'renderer_waking' && (
                    <p className="text-[10px] text-wx-mute mt-1">Renderer waking up…</p>
                  )}
                  {hiRes && (level2Error === 'renderer_unreachable' || level2Error === 'renderer_timeout') && (
                    <p className="text-[10px] text-wx-mute mt-1">Renderer slow or unreachable — will retry automatically</p>
                  )}
                  {hiRes && level2Error && level2Error !== 'renderer_not_configured' && level2Error !== 'renderer_waking' && level2Error !== 'renderer_unreachable' && level2Error !== 'renderer_timeout' && (
                    <p className="text-[10px] text-wx-danger mt-1">Level II error: {level2Error}</p>
                  )}
                  {hiRes && level2Overlay && !level2Loading && (
                    <p className="text-[10px] text-wx-mute mt-1">
                      Scan {new Date(level2Overlay.scan_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} UTC
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Active warnings list */}
            <div>
              <div className="panel-title text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Active warnings · {warnings.length}</div>
              <div className="flex flex-col gap-1">
                {warnings.slice(0, 5).map((w) => (
                  <button key={w.id} onClick={() => focusWarning(w)} className="flex items-center gap-2 p-2 rounded-lg bg-wx-ink border border-wx-line text-left hover:border-wx-accent">
                    <span className={`px-1.5 py-0.5 text-[9px] rounded ${w.type === 'tornado' ? 'bg-red-500/20 text-red-300' : w.type === 'severe' ? 'bg-orange-500/20 text-orange-300' : 'bg-emerald-500/20 text-emerald-300'}`}>{w.type.toUpperCase()}</span>
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-semibold truncate">{w.label.split('·')[1]?.trim() || w.event}</div>
                      <div className="text-[10px] text-wx-mute">Until {w.expires_at ? new Date(w.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Pointer readout */}
            <div>
              <div className="panel-title text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Pointer</div>
              <div className="space-y-0.5 text-[11px] font-mono">
                <div className="flex justify-between"><span className="text-wx-mute">Lat</span><span>{hoverPixel ? hoverPixel.lat.toFixed(4) : '—'}</span></div>
                <div className="flex justify-between"><span className="text-wx-mute">Lon</span><span>{hoverPixel ? hoverPixel.lng.toFixed(4) : '—'}</span></div>
                <div className="flex justify-between"><span className="text-wx-mute">Sample</span><span className={hoverPixel ? 'text-wx-accent' : 'text-wx-mute'}>{hoverPixel?.sample ? `${hoverPixel.sample} dBZ` : '—'}</span></div>
              </div>
            </div>
          </div>
        )}

        {/* Audience drawer */}
        {selection && (
          <div className="audience-drawer absolute bottom-4 left-4 w-[320px] p-5 bg-wx-card border border-wx-line rounded-xl z-30">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-[0.06em] text-wx-mute font-semibold">Audience in area</div>
                <div className="text-[30px] font-extrabold leading-none mt-1">{previewCount ?? '—'}</div>
              </div>
              <button onClick={cancelDraw} className="icon-btn w-8 h-8"><Trash2 size={14} /></button>
            </div>
            <div className="text-[11.5px] text-wx-mute mt-1 font-mono">
              {selection.type === 'circle' ? <>Circle · {selection.radius_km.toFixed(1)} km · {selection.center[1].toFixed(3)}, {selection.center[0].toFixed(3)}</> : <>Polygon · {selection.coordinates.length - 1} vertices</>}
            </div>

            <div className="grid grid-cols-3 gap-2 mt-3.5 pt-3.5 border-t border-wx-line">
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.memphis}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">Memphis</div></div>
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.tn}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">TN side</div></div>
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.ms}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">MS / AR</div></div>
            </div>

            <button onClick={goToCompose} className="mt-3.5 w-full bg-wx-accent text-black rounded-lg font-semibold text-sm py-2 flex items-center justify-center gap-2 hover:bg-amber-300">
              <Send size={14} /> Send alert to area
            </button>
          </div>
        )}

        {/* Timeline */}
        <div className="timeline absolute bottom-4 left-1/2 -translate-x-1/2 w-[min(880px,calc(100%-380px))] min-w-[520px] z-30">
          <div className="timeline-card bg-wx-card border border-wx-line rounded-xl px-4 py-3.5 flex items-center gap-3.5">
            <button onClick={() => setPlaying((p) => !p)} className="play-btn w-9 h-9 rounded-lg bg-wx-accent text-black grid place-items-center hover:bg-amber-300">
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>

            <div className="time-track flex-1 relative h-8" onMouseDown={(e) => {
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
              setFrame(Math.round((x / rect.width) * (TIMELINE_FRAMES - 1)));
            }}>
              <div className="time-rail absolute left-0 right-0 top-1/2 h-1 bg-wx-line rounded-sm overflow-hidden -translate-y-1/2">
                <div className="now-fill absolute left-0 top-0 bottom-0 bg-wx-ok opacity-65" style={{ width: `${((OBSERVED_COUNT - 1) / (TIMELINE_FRAMES - 1)) * 100}%` }} />
                <div className="forecast-region absolute right-0 top-0 bottom-0 bg-[repeating-linear-gradient(45deg,rgba(251,191,36,0.08)_0_5px,rgba(251,191,36,0.20)_5px_10px)] border-l border-amber-500/50" style={{ width: `${(1 - (OBSERVED_COUNT - 1) / (TIMELINE_FRAMES - 1)) * 100}%` }} />
              </div>
              <div className="time-frames absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between px-0.5 pointer-events-none">
                {Array.from({ length: TIMELINE_FRAMES }).map((_, i) => (
                  <div key={i} className={`frame-tick w-[1.5px] h-[7px] bg-wx-mute/50 rounded ${i === 0 || i === OBSERVED_COUNT - 1 || i === TIMELINE_FRAMES - 1 ? 'h-3 opacity-90' : ''}`} />
                ))}
              </div>
              <div className="time-handle absolute top-1/2 w-[14px] h-[14px] rounded-full bg-wx-accent border-2 border-wx-ink -translate-x-1/2 -translate-y-1/2" style={{ left: `${(frame / (TIMELINE_FRAMES - 1)) * 100}%` }} />
            </div>

            <div className="time-readout flex flex-col items-end gap-0.5 min-w-[96px]">
              <span className={`badge text-[10px] px-1.5 py-0.5 rounded border font-semibold tracking-wider uppercase ${isForecastFrame ? 'border-wx-accent text-wx-accent' : 'border-wx-line text-wx-fg'}`}>{isForecastFrame ? 'FORECAST' : 'OBSERVED'}</span>
              <span className="text-[15px] font-bold">{frameTimeLabel}</span>
              <span className="text-[11px] text-wx-mute">{relLabel}</span>
            </div>

            <button onClick={() => {
              const order: ('0.5x' | '1x' | '2x' | '4x')[] = ['0.5x', '1x', '2x', '4x'];
              setSpeed(order[(order.indexOf(speed) + 1) % order.length]);
            }} className="speed-btn text-[11px] px-2.5 py-1.5 border border-wx-line rounded-md hover:border-wx-accent">{speed}</button>
          </div>
        </div>

        {/* Coords readout bottom right */}
        {hoverPixel && (
          <div className="absolute bottom-4 right-4 font-mono text-[11px] bg-wx-card border border-wx-line rounded-md px-2.5 py-1.5 z-20">
            <span className="text-wx-mute">lat</span> {hoverPixel.lat.toFixed(3)} <span className="text-wx-mute">lon</span> {hoverPixel.lng.toFixed(3)} <span className="text-wx-mute">· dBZ</span> {hoverPixel.sample ?? '—'}
          </div>
        )}

        {/* Radar site chips (HTML overlay) */}
        <div className="absolute inset-0 pointer-events-none z-10">
          {Object.keys(RADAR_SITES).map((code) => {
            const site = RADAR_SITES[code];
            const isActive = selectedSite === code;
            const p = screenPoint(site.center);
            if (!p) return null;
            return (
              <div key={code} className="absolute pointer-events-auto" style={{ left: p.x, top: p.y, transform: 'translate(-50%, -100%)' }}>
                {isActive && <div className="absolute left-1/2 top-full -translate-x-1/2 -translate-y-1/2 w-[230px] h-[230px] rounded-full border border-dashed border-white/10" style={{ background: 'radial-gradient(circle, rgba(251,191,36,0.06) 0%, transparent 70%)' }} />}
                <button onClick={() => { mapRef.current?.flyTo({ center: site.center, zoom: site.zoom, duration: 700 }); setSelectedSite(code); }} className={`site-chip inline-flex items-center gap-1.5 px-2.5 py-1 bg-wx-card border border-wx-line rounded-lg text-[11px] font-semibold ${isActive ? 'bg-wx-accent text-black border-wx-accent' : 'hover:border-wx-accent'}`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-wx-mute" /> {code} <span className="opacity-60 font-medium text-[10px]">{site.name.split(' ').pop()}</span>
                </button>
              </div>
            );
          })}
        </div>

        {/* Subscriber hover tooltip */}
        {hoverSub && (
          <div className="map-tooltip absolute z-50 bg-wx-card border border-wx-line rounded-lg px-2.5 py-2 text-[11px]" style={{ left: hoverPos.x + 12, top: hoverPos.y - 20 }}>
            <div className="font-semibold text-wx-fg">{hoverSub.name}</div>
            <div className="text-[10px] text-wx-mute">{hoverSub.zip || '—'}</div>
            <div className="font-mono text-[10px] text-wx-mute mt-0.5">{hoverPixel?.lat.toFixed(3)}, {hoverPixel?.lng.toFixed(3)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
