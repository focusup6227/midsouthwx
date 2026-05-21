'use client';

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Map, { Source, Layer, type MapMouseEvent, type MapRef } from 'react-map-gl';
import mapboxgl from 'mapbox-gl';
import { supabaseBrowser } from '@/lib/supabase/client';
import { mapboxAccessToken } from '@/lib/supabase/env';
import {
  CloudLightning, Radio, Wind, Atom, RotateCw,
  Play, Pause, Trash2, Send, Circle, Target,
} from 'lucide-react';

// Three providers, picked per product based on which one actually publishes that
// product as a public tile feed:
//   - RainViewer (api.rainviewer.com) — CONUS composite reflectivity with real past
//     frames (2h history at 10 min intervals + nowcast). Drives the timeline.
//   - NOAA NCEP GeoServer (opengeo.ncep.noaa.gov) — per-site reflectivity / velocity.
//     Single-frame ("NOW") because NCEP doesn't expose history.
//   - UCAR THREDDS ncWMS (thredds.ucar.edu) — MRMS Az-Shear 0-2km AGL rotation.
//     Composite-only; resolves the latest dataset URL through /api/radar/mrms-latest.
//   - Fly.io Level II renderer — single-site Correlation Coefficient (ρhv) and the
//     Hi-Res reflectivity/velocity options.
type ProductKey = 'composite' | 'reflectivity' | 'velocity' | 'correlation' | 'rotation';

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

// RainViewer free Weather Maps API. Returns 2h of past frames + nowcast.
// Color scheme 8 = NWS Reflectivity (matches radar.weather.gov palette).
// Options "1_1" = smoothed + snow-aware.
// 512px tiles double the spatial resolution at the same z (max zoom 7 on the
// free tier), so the imagery stays readable down to the city block at z~11.
const RAINVIEWER_INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const RAINVIEWER_COLOR = 8;
const RAINVIEWER_OPTS = '1_1';
const RAINVIEWER_TILE_SIZE = 512;
const RAINVIEWER_MAX_ZOOM = 7;

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
  coordinates: number[][];
};

type SweepInfo = { index: number; elevation_deg: number };

type Level2Overlay = {
  geojson_url?: string | null;
  image_url?: string | null;
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

type RainViewerFrame = { time: number; path: string };
type RainViewerIndex = {
  host: string;
  radar: { past: RainViewerFrame[]; nowcast: RainViewerFrame[] };
};

const WARNING_FILL_EXPR: any = [
  'match', ['get', 'type'],
  'tornado', 'rgba(239,68,68,0.18)',
  'severe',  'rgba(249,115,22,0.18)',
  'flood',   'rgba(16,185,129,0.18)',
  /* other */ 'rgba(148,163,184,0.12)',
];
const WARNING_LINE_EXPR: any = [
  'match', ['get', 'type'],
  'tornado', '#ef4444',
  'severe',  '#f97316',
  'flood',   '#10b981',
  /* other */ '#94a3b8',
];

export default function RadarView() {
  const [subsGeo, setSubsGeo] = useState<any>({ type: 'FeatureCollection', features: [] });
  const [product, setProduct] = useState<ProductKey>('composite');
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [hiRes, setHiRes] = useState(false);
  const [pngFallback, setPngFallback] = useState(false);
  const [selectedElevation, setSelectedElevation] = useState<number | 'composite'>(0.5);
  const [level2Loading, setLevel2Loading] = useState(false);
  const [level2Error, setLevel2Error] = useState<string | null>(null);
  const [level2Overlay, setLevel2Overlay] = useState<Level2Overlay | null>(null);
  const [level2GeoJSON, setLevel2GeoJSON] = useState<any>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [drawMode, setDrawMode] = useState<'none' | 'circle-center' | 'circle-radius' | 'polygon'>('none');
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const [circleCenter, setCircleCenter] = useState<[number, number] | null>(null);
  const [tileCacheKey, setTileCacheKey] = useState(() => Math.floor(Date.now() / 60_000));
  const [mrmsUrlPath, setMrmsUrlPath] = useState<string | null>(null);

  // RainViewer index drives the timeline for CONUS composite mode.
  const [rvIndex, setRvIndex] = useState<RainViewerIndex | null>(null);

  const [opacity, setOpacity] = useState(78);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<'0.5x' | '1x' | '2x' | '4x'>('1x');
  const [warnings, setWarnings] = useState<NwsWarning[]>([]);
  const [hoverPixel, setHoverPixel] = useState<{ lng: number; lat: number; sample: number | null } | null>(null);
  const [hoverSub, setHoverSub] = useState<any | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [audienceBreakdown, setAudienceBreakdown] = useState<AudienceBreakdown>({ memphis: 0, tn: 0, ms: 0 });

  const [showSubs, setShowSubs] = useState(true);
  const subsCount = subsGeo.features?.length ?? 0;

  const mapCursor = drawMode !== 'none' ? 'crosshair' : 'grab';

  const [viewState, setViewState] = useState({
    longitude: -89.8,
    latitude: 35.0,
    zoom: 7,
  });

  const mapRef = useRef<MapRef>(null);
  const token = mapboxAccessToken();
  const [radarBeforeId, setRadarBeforeId] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      mapboxgl.accessToken = token;
    }
  }, [token]);

  // Anchor the radar *just below the first line or symbol layer* in the style.
  // Mapbox stacks layers in array order: background → fills (water, landuse) →
  // lines (waterways, roads, admin) → symbols (labels). Inserting before the
  // first non-fill layer pushes the radar above terrain/water but keeps every
  // road, county/state boundary, and label rendered on top of the radar.
  const resolvedBeforeIdRef = useRef<string | null>(null);
  const handleMapLoad = useCallback(() => {
    if (resolvedBeforeIdRef.current) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layers = map.getStyle()?.layers ?? [];
    const anchor = layers.find(
      (l: any) => l.type === 'line' || l.type === 'symbol' || l.type === 'circle',
    );
    if (anchor) {
      resolvedBeforeIdRef.current = anchor.id;
      setRadarBeforeId(anchor.id);
    }
  }, []);

  useEffect(() => {
    fetch('/api/radar/subs')
      .then((r) => r.json())
      .then((geo) => setSubsGeo(geo || { type: 'FeatureCollection', features: [] }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTileCacheKey(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(id);
  }, []);

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
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Pull the RainViewer index every 2 min so new past frames appear in the
  // timeline as they're published.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(RAINVIEWER_INDEX_URL, { cache: 'no-store' });
        const j = (await r.json()) as RainViewerIndex;
        if (cancelled) return;
        if (j?.host && j?.radar) setRvIndex(j);
      } catch {/* ignore */}
    };
    load();
    const id = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    fetch('/api/radar/warnings')
      .then((r) => r.json())
      .then((j) => setWarnings(j?.warnings ?? []))
      .catch(() => {});
  }, []);

  const effectiveProduct: ProductKey = useMemo(() => {
    const meta = PRODUCTS[product];
    if (selectedSite && !meta.modes.site) return 'reflectivity';
    if (!selectedSite && !meta.modes.composite) return 'composite';
    return product;
  }, [product, selectedSite]);

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

  // ── Timeline frames ──────────────────────────────────────────────────
  // RainViewer drives the timeline ONLY for CONUS composite (its native dataset).
  // Every other product is a single live frame — we don't fabricate forecasts.
  const useRainViewer = !selectedSite && effectiveProduct === 'composite';
  const rvAllFrames = useMemo<RainViewerFrame[]>(() => {
    if (!useRainViewer || !rvIndex) return [];
    return [...(rvIndex.radar?.past ?? []), ...(rvIndex.radar?.nowcast ?? [])];
  }, [useRainViewer, rvIndex]);
  const rvPastCount = useMemo(() => rvIndex?.radar?.past?.length ?? 0, [rvIndex]);
  const totalFrames = useRainViewer ? Math.max(1, rvAllFrames.length) : 1;

  // Pin frame to the latest past frame whenever the frame list changes (e.g.
  // a new past frame just arrived, or the user switched away from RainViewer).
  const prevTotal = useRef(0);
  useEffect(() => {
    if (!useRainViewer) {
      setFrame(0);
      setPlaying(false);
      return;
    }
    if (rvPastCount && prevTotal.current !== totalFrames) {
      setFrame(Math.max(0, rvPastCount - 1));
      prevTotal.current = totalFrames;
    }
  }, [useRainViewer, rvPastCount, totalFrames]);

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

    const RETRY_DELAYS = [4000, 8000, 12000];
    const format = pngFallback ? 'png' : 'geojson';

    const load = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      setLevel2Loading(true);

      try {
        const url = `/api/radar/level2/${selectedSite}`
          + `?product=${level2Product}`
          + `&format=${format}`
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

        setLevel2Overlay(data as Level2Overlay);
        setLevel2Error(null);

        if (format === 'png') {
          // PNG path: nothing else to download — the renderer URL is a public
          // PNG, Mapbox image source handles the rest.
          setLevel2GeoJSON(null);
          return;
        }

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
    const id = setInterval(() => load(0), 300_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [useLevel2, selectedSite, level2Product, resolvedSweepIndex, isComposite, pngFallback]);

  const radarSourceId = 'radar-source';
  const radarLayerId = 'radar-layer';
  const level2GeoJSONSourceId = 'level2-geojson';
  const level2ImageSourceId = 'level2-image';

  // Non-RainViewer products render a single "now" tile URL (NCEP / THREDDS).
  const liveTileUrl: string | null = useMemo(() => {
    if (useRainViewer) return null;
    if (selectedSite) {
      const site = selectedSite.toLowerCase();
      switch (effectiveProduct) {
        case 'reflectivity':
          return NCEP_WMS_URL(site, `${site}:${site}_sr_bref`, tileCacheKey);
        case 'velocity':
          return NCEP_WMS_URL(site, `${site}:${site}_sr_bvel`, tileCacheKey);
        case 'correlation':
          return null; // Level II only
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
  }, [effectiveProduct, selectedSite, tileCacheKey, mrmsUrlPath, useRainViewer]);

  const rvFrameUrl = useCallback((f: RainViewerFrame) => {
    if (!rvIndex) return '';
    return `${rvIndex.host}${f.path}/${RAINVIEWER_TILE_SIZE}/{z}/{x}/{y}/${RAINVIEWER_COLOR}/${RAINVIEWER_OPTS}.png`;
  }, [rvIndex]);

  // Stable key for the live source — only swap when the URL *pattern* changes
  // (provider / site / product / MRMS dataset), not on every frame.
  const liveSourceKey = useMemo(() => {
    const base = selectedSite ? `site:${selectedSite.toLowerCase()}` : 'conus';
    return `${base}:${effectiveProduct}:${mrmsUrlPath ?? '-'}:${tileCacheKey}`;
  }, [selectedSite, effectiveProduct, tileCacheKey, mrmsUrlPath]);

  const liveRadarSource = useMemo(() => {
    if (!liveTileUrl) return null;
    return { type: 'raster' as const, tiles: [liveTileUrl], tileSize: 256 };
  }, [liveTileUrl]);

  const level2GeoJSONSource = useMemo(() => {
    if (!useLevel2 || pngFallback || !level2GeoJSON) return null;
    return { type: 'geojson' as const, data: level2GeoJSON };
  }, [useLevel2, pngFallback, level2GeoJSON]);

  const level2ImageSource = useMemo(() => {
    if (!useLevel2 || !pngFallback || !level2Overlay?.image_url) return null;
    const { north, south, east, west } = level2Overlay.bounds;
    return {
      type: 'image' as const,
      url: level2Overlay.image_url,
      coordinates: [
        [west, north], [east, north], [east, south], [west, south],
      ] as [number, number][],
    };
  }, [useLevel2, pngFallback, level2Overlay]);

  const liveRadarLayer = {
    id: radarLayerId,
    type: 'raster' as const,
    source: radarSourceId,
    paint: {
      'raster-opacity': opacity / 100,
      'raster-fade-duration': 0,
      'raster-resampling': 'nearest' as const,
    },
    ...(radarBeforeId ? { beforeId: radarBeforeId } : {}),
  };

  const rvLayerId = (i: number) => `rv-layer-${i}`;
  const rvSourceId = (i: number) => `rv-src-${i}`;

  const level2FillLayer = {
    id: 'level2-fill',
    type: 'fill' as const,
    source: level2GeoJSONSourceId,
    paint: {
      'fill-color': level2Overlay
        ? buildFillColorExpr(level2Product, level2Overlay.vmin, level2Overlay.vmax)
        : '#000000',
      'fill-opacity': level2Overlay
        ? buildFillOpacityExpr(level2Product, opacity / 100,
                               level2Overlay.vmin, level2Overlay.vmax)
        : 0,
      'fill-antialias': true,
    },
    ...(radarBeforeId ? { beforeId: radarBeforeId } : {}),
  };

  const level2RasterLayer = {
    id: 'level2-raster',
    type: 'raster' as const,
    source: level2ImageSourceId,
    paint: {
      'raster-opacity': opacity / 100,
      'raster-fade-duration': 0,
      'raster-resampling': 'linear' as const,
    },
    ...(radarBeforeId ? { beforeId: radarBeforeId } : {}),
  };

  // Live opacity + RainViewer frame visibility, all imperatively so swapping
  // frames during playback never tears down a source (tiles stay in Mapbox
  // cache → buttery scrubbing once each frame has been seen once).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (map.getLayer(radarLayerId)) {
      map.setPaintProperty(radarLayerId, 'raster-opacity', useRainViewer ? 0 : opacity / 100);
    }
    if (useRainViewer) {
      rvAllFrames.forEach((_, i) => {
        const id = rvLayerId(i);
        if (map.getLayer(id)) {
          map.setPaintProperty(id, 'raster-opacity', i === frame ? opacity / 100 : 0);
        }
      });
    }
    if (map.getLayer('level2-raster')) {
      map.setPaintProperty('level2-raster', 'raster-opacity', opacity / 100);
    }
    if (map.getLayer('level2-fill') && level2Overlay) {
      map.setPaintProperty(
        'level2-fill',
        'fill-opacity',
        buildFillOpacityExpr(level2Product, opacity / 100, level2Overlay.vmin, level2Overlay.vmax),
      );
    }
  }, [opacity, level2Overlay, level2Product, useRainViewer, rvAllFrames, frame]);

  // ── Warning polygons ─────────────────────────────────────────────────
  const warningsGeo = useMemo(() => {
    return {
      type: 'FeatureCollection' as const,
      features: warnings
        .filter((w) => w.geometry)
        .map((w) => ({
          type: 'Feature' as const,
          id: w.id,
          geometry: w.geometry,
          properties: {
            id: w.id,
            type: w.type,
            event: w.event,
            label: w.label,
            expires_at: w.expires_at,
          },
        })),
    };
  }, [warnings]);

  // Subscribers
  const subsHaloLayer: any = {
    id: 'subs-halo', type: 'circle' as const, source: 'subs-source',
    layout: { visibility: showSubs ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 7, 12, 10, 20, 14, 28],
      'circle-color': '#38bdf8', 'circle-opacity': 0.25, 'circle-blur': 0.55,
    },
  };
  const subsPinLayer: any = {
    id: 'subs-pin', type: 'circle' as const, source: 'subs-source',
    layout: { visibility: showSubs ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 7, 5, 10, 7, 14, 9],
      'circle-color': '#38bdf8',
      'circle-stroke-color': '#0b1220',
      'circle-stroke-width': 1.5,
    },
  };

  const handleMapClick = (e: MapMouseEvent) => {
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
      return;
    }
    if (drawMode === 'circle-radius' && circleCenter) {
      const toRad = (d: number) => (d * Math.PI) / 180;
      const R = 6371;
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
      previewAudience(newSel);
      return;
    }
    if (drawMode === 'polygon') {
      const pts = [...polygonPoints, [lng, lat] as [number, number]];
      setPolygonPoints(pts);
      return;
    }

    // Not in draw mode → see if the click lands on a subscriber pin first
    // (smaller targets win over the larger warning polygons underneath).
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (showSubs && map.getLayer('subs-pin')) {
      const subHits = map.queryRenderedFeatures(e.point, { layers: ['subs-pin'] });
      if (subHits.length > 0) {
        const props = subHits[0].properties as any;
        if (props?.id) {
          window.open(`/subscribers/${props.id}`, '_blank');
          return;
        }
      }
    }
    if (!map.getLayer('warning-fill')) return;
    const hits = map.queryRenderedFeatures(e.point, { layers: ['warning-fill'] });
    if (hits.length > 0) {
      const w = warnings.find((x) => x.id === (hits[0].properties as any)?.id);
      if (w) focusWarning(w);
    }
  };

  const completePolygon = () => {
    if (polygonPoints.length < 3) return;
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

  const startCircleDraw = () => { cancelDraw(); setDrawMode('circle-center'); };
  const startPolygonDraw = () => { cancelDraw(); setDrawMode('polygon'); setPolygonPoints([]); };

  const previewAudience = async (sel: Selection) => {
    const supa = supabaseBrowser();
    let spec: any = {};
    if (sel.type === 'circle') {
      spec = { geometry: { type: 'circle', center: sel.center, radius_km: sel.radius_km } };
    } else {
      spec = { geometry: { type: 'Polygon', coordinates: [sel.coordinates] } };
    }
    const { data, error } = await supa.rpc('resolve_audience', { spec });
    if (!error && data) setPreviewCount(data.length);
    else setPreviewCount(0);
  };

  const goToCompose = () => {
    if (!selection) return;
    const params = new URLSearchParams();
    if (selection.type === 'circle') {
      params.set('geo', JSON.stringify({ type: 'circle', center: selection.center, radius_km: selection.radius_km }));
    } else {
      params.set('geo', JSON.stringify({ type: 'polygon', coordinates: selection.coordinates }));
    }
    window.location.href = `/compose?${params.toString()}`;
  };

  // Playback driver. Uses setTimeout so the dwell-at-NOW pause is variable per
  // frame; re-runs whenever frame changes, which is cheap and predictable.
  useEffect(() => {
    if (!playing || !useRainViewer || totalFrames <= 1) return;
    const baseMs = { '0.5x': 800, '1x': 400, '2x': 220, '4x': 110 }[speed] ?? 400;
    // Pause briefly when we land on the most-recent observed frame so the
    // viewer can read the "now" state before the loop continues into nowcast
    // (or wraps back to the oldest past frame).
    const dwell = frame === rvPastCount - 1 ? Math.max(baseMs * 4, 1400) : baseMs;
    const id = setTimeout(() => {
      setFrame((f) => (f + 1) % totalFrames);
    }, dwell);
    return () => clearTimeout(id);
  }, [playing, speed, useRainViewer, totalFrames, rvPastCount, frame]);

  // ── Scrub + keyboard ─────────────────────────────────────────────────
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);

  const scrubAtClientX = useCallback((clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    return Math.round((x / rect.width) * Math.max(0, totalFrames - 1));
  }, [totalFrames]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const f = scrubAtClientX(e.clientX);
      if (f != null) setFrame(f);
    };
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [scrubAtClientX]);

  // Keyboard shortcuts. Skipped when focus is on an input so the opacity
  // slider, etc. keep working.
  useEffect(() => {
    if (!useRainViewer || totalFrames <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setPlaying(false);
        setFrame((f) => Math.max(0, f - 1));
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        setFrame((f) => Math.min(totalFrames - 1, f + 1));
      } else if (e.code === 'Home') {
        e.preventDefault();
        setPlaying(false);
        setFrame(0);
      } else if (e.code === 'End') {
        e.preventDefault();
        setPlaying(false);
        setFrame(totalFrames - 1);
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setPlaying(false);
        setFrame(Math.max(0, rvPastCount - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [useRainViewer, totalFrames, rvPastCount]);

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

  const focusWarning = (w: NwsWarning) => {
    mapRef.current?.flyTo({ center: w.centroid, zoom: 8.5, duration: 800 });
  };

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
  void mapPos;

  const screenPoint = (lngLat: [number, number]) => {
    const map = mapRef.current?.getMap();
    return map ? map.project(lngLat) : null;
  };

  // Active frame's wall-clock time (RainViewer = real timestamp; otherwise NOW).
  const frameTimeLabel = useMemo(() => {
    let d: Date;
    if (useRainViewer && rvAllFrames[frame]) {
      d = new Date(rvAllFrames[frame].time * 1000);
    } else {
      d = new Date();
    }
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }, [frame, useRainViewer, rvAllFrames]);

  const isForecastFrame = useRainViewer && frame >= rvPastCount;
  const relLabel = useMemo(() => {
    if (!useRainViewer) return 'LIVE';
    const f = rvAllFrames[frame];
    if (!f) return '—';
    const nowSec = Math.floor(Date.now() / 1000);
    const diffMin = Math.round((f.time - nowSec) / 60);
    if (diffMin === 0) return 'NOW';
    return diffMin > 0 ? `+${diffMin} min` : `${diffMin} min`;
  }, [useRainViewer, frame, rvAllFrames]);

  // Convert quantized `v` (0-255) to natural units for the hover readout.
  const sampleLabel = useMemo(() => {
    if (!hoverPixel || hoverPixel.sample == null) return '—';
    if (effectiveProduct === 'correlation') return `${hoverPixel.sample.toFixed(2)} ρhv`;
    if (effectiveProduct === 'velocity' && useLevel2) return `${hoverPixel.sample.toFixed(0)} kt`;
    return `${hoverPixel.sample.toFixed(0)} dBZ`;
  }, [hoverPixel, effectiveProduct, useLevel2]);

  return (
    <div className="h-[calc(100vh-3.5rem)] md:h-[calc(100vh-3.25rem)] flex flex-col bg-wx-ink text-wx-fg">
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
            const map = mapRef.current?.getMap();
            const { lng, lat } = e.lngLat;
            // Pull the quantized `v` from any Level II wedge under the pointer
            // and convert back to natural units using the active vmin/vmax.
            // Guard against the brief window where overlay metadata has
            // arrived but the GeoJSON layer hasn't been added yet (queryRF
            // throws on unknown layer ids).
            let sample: number | null = null;
            if (map && useLevel2 && !pngFallback && level2Overlay && map.getLayer('level2-fill')) {
              const hits = map.queryRenderedFeatures(e.point, { layers: ['level2-fill'] });
              if (hits.length > 0) {
                const q = (hits[0].properties as any)?.v;
                if (typeof q === 'number') {
                  const range = level2Overlay.vmax - level2Overlay.vmin || 1;
                  sample = level2Overlay.vmin + (q / 255) * range;
                }
              }
            }
            setHoverPixel({ lng, lat, sample });

            // Use Mapbox's spatial query for subscriber pins so hover lines
            // up with the rendered pin radius at every zoom.
            if (map && showSubs && map.getLayer('subs-pin')) {
              const subHits = map.queryRenderedFeatures(e.point, { layers: ['subs-pin'] });
              if (subHits.length > 0) {
                setHoverPos({ x: e.point.x, y: e.point.y });
                setHoverSub(subHits[0].properties);
              } else {
                setHoverSub(null);
              }
            } else {
              setHoverSub(null);
            }
          }}
          onMouseLeave={() => { setHoverPixel(null); setHoverSub(null); }}
        >
          {liveRadarSource && (
            <Source key={liveSourceKey} id={radarSourceId} {...liveRadarSource}>
              <Layer {...liveRadarLayer} />
            </Source>
          )}

          {/* Render every RainViewer frame as its own raster source. Only the
              active frame is visible (opacity); all others sit at opacity 0 so
              their tiles stay in Mapbox's cache. After one full pass through
              the loop, every subsequent scrub/playback step is instant — no
              tile re-fetch, no flicker.
              maxzoom is fixed to RainViewer's free-tier cap so Mapbox
              over-scales (instead of going blank) past city-level zoom. */}
          {useRainViewer && rvAllFrames.map((f, i) => (
            <Source
              key={`rv-src-${f.time}`}
              id={rvSourceId(i)}
              type="raster"
              tiles={[rvFrameUrl(f)]}
              tileSize={RAINVIEWER_TILE_SIZE}
              maxzoom={RAINVIEWER_MAX_ZOOM}
            >
              <Layer
                id={rvLayerId(i)}
                type="raster"
                paint={{
                  'raster-opacity': i === frame ? opacity / 100 : 0,
                  'raster-fade-duration': 0,
                  // 'linear' smooths the over-scaled tiles past z7 instead of
                  // showing crunchy nearest-neighbor squares.
                  'raster-resampling': 'linear',
                }}
                {...(radarBeforeId ? { beforeId: radarBeforeId } : {})}
              />
            </Source>
          ))}

          {level2GeoJSONSource && (
            <Source
              key={`level2gj:${selectedSite}:${level2Product}:${level2Overlay?.scan_time}:${resolvedSweepIndex}:${isComposite ? 'c' : 'b'}`}
              id={level2GeoJSONSourceId}
              {...level2GeoJSONSource}
            >
              <Layer {...level2FillLayer} />
            </Source>
          )}

          {level2ImageSource && (
            <Source
              key={`level2png:${selectedSite}:${level2Product}:${level2Overlay?.scan_time}:${resolvedSweepIndex}:${isComposite ? 'c' : 'b'}`}
              id={level2ImageSourceId}
              {...level2ImageSource}
            >
              <Layer {...level2RasterLayer} />
            </Source>
          )}

          <Source id="warning-source" type="geojson" data={warningsGeo as any}>
            <Layer id="warning-fill" type="fill" paint={{ 'fill-color': WARNING_FILL_EXPR }} />
            <Layer id="warning-line" type="line" paint={{
              'line-color': WARNING_LINE_EXPR,
              'line-width': 2,
              'line-opacity': 0.85,
            }} />
          </Source>

          <Source id="subs-source" type="geojson" data={subsGeo}>
            <Layer {...subsHaloLayer} />
            <Layer {...subsPinLayer} />
          </Source>

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

          {drawMode === 'polygon' && polygonPoints.length > 0 && (
            <Source id="poly-draw" type="geojson" data={{ type: 'Feature', geometry: { type: 'LineString', coordinates: polygonPoints }, properties: {} }}>
              <Layer id="poly-line" type="line" paint={{ 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [2, 1] }} />
            </Source>
          )}
        </Map>

        {/* Products rail (left) */}
        <div className="products-rail absolute top-4 left-4 w-[68px] bg-wx-card border border-wx-line rounded-xl p-1.5 flex flex-col gap-0.5 z-20">
          {(Object.keys(PRODUCTS) as ProductKey[]).map((k) => {
            const p = PRODUCTS[k];
            const Icon = p.icon;
            const allowed = selectedSite ? p.modes.site : p.modes.composite;
            const disabled = !allowed || (k === 'rotation' && !mrmsUrlPath);
            const active = effectiveProduct === k;
            return (
              <button
                key={k}
                onClick={() => !disabled && selectProduct(k)}
                disabled={disabled}
                title={disabled ? (selectedSite ? 'Not available in single-site mode' : 'Pick a radar site to use this product') : p.label}
                className={`flex flex-col items-center justify-center gap-0.5 py-2 rounded-lg text-[10px] font-semibold tracking-wide transition ${active ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'text-wx-mute hover:text-wx-fg'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <Icon size={20} className={active ? 'text-wx-accent' : ''} />
                <span>{p.short}</span>
              </button>
            );
          })}
        </div>

        {/* Draw toolbar */}
        <div className="absolute top-4 left-[100px] flex gap-2 items-center z-20">
          <button onClick={startCircleDraw} className={`px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm flex items-center gap-1.5 ${drawMode.includes('circle') ? 'bg-wx-accent text-black border-wx-accent' : ''}`}>
            <Circle size={14} /> Circle
          </button>
          <button onClick={startPolygonDraw} className={`px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm flex items-center gap-1.5 ${drawMode === 'polygon' ? 'bg-wx-accent text-black border-wx-accent' : ''}`}>
            <Target size={14} /> Polygon
          </button>
          {drawMode === 'polygon' && (
            <button onClick={completePolygon} disabled={polygonPoints.length < 3} className="px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm disabled:opacity-50">Complete ({polygonPoints.length})</button>
          )}
          {(drawMode !== 'none' || selection) && (
            <button onClick={cancelDraw} className="px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm text-wx-mute hover:text-wx-danger hover:border-wx-danger flex items-center gap-1.5">
              <Trash2 size={14} /> Clear
            </button>
          )}
          {drawMode === 'circle-center' && <div className="text-[11px]"><span className="px-1.5 py-0.5 text-[10px] border border-wx-line rounded bg-wx-ink">Click</span> set center</div>}
          {drawMode === 'circle-radius' && <div className="text-[11px]"><span className="px-1.5 py-0.5 text-[10px] border border-wx-line rounded bg-wx-ink">Click</span> set radius</div>}
          {drawMode === 'polygon' && polygonPoints.length === 0 && <div className="text-[11px]"><span className="px-1.5 py-0.5 text-[10px] border border-wx-line rounded bg-wx-ink">Click</span> add vertex</div>}
        </div>

        {warnings.length > 0 && (
          <div className="absolute top-16 left-[100px] flex flex-wrap gap-2 max-w-[calc(100%-100px-340px)] z-10">
            {warnings.slice(0, 6).map((w) => (
              <button key={w.id} onClick={() => focusWarning(w)} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium ${w.type === 'tornado' ? 'border-red-500/50 text-red-300' : w.type === 'severe' ? 'border-orange-500/50 text-orange-300' : w.type === 'flood' ? 'border-emerald-500/50 text-emerald-300' : 'border-slate-500/50 text-slate-300'}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" /> {w.label}
              </button>
            ))}
          </div>
        )}

        {/* Inspector */}
        {!selection && (
          <div className="absolute top-4 right-4 w-[304px] max-h-[calc(100%-220px)] overflow-y-auto p-4 bg-wx-card border border-wx-line rounded-xl flex flex-col gap-[18px] z-20 wx-scroll">
            <div>
              <div className="flex items-center justify-between text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                <span>Legend · {PRODUCTS[effectiveProduct].short}</span>
                <span className="font-mono text-[10px] text-wx-mute">
                  {(() => {
                    if (useRainViewer) return 'CONUS · RainViewer';
                    if (effectiveProduct === 'rotation') return 'MRMS · CONUS';
                    if (useLevel2) {
                      const tiltLabel = isComposite
                        ? 'COMP'
                        : (() => {
                            const s = availableSweeps.find((x) => x.index === resolvedSweepIndex);
                            return s ? formatElev(s.elevation_deg) : '—';
                          })();
                      if (effectiveProduct === 'correlation') return `Level II · ρhv · ${tiltLabel}`;
                      return `Level II · ${tiltLabel}${pngFallback ? ' · PNG' : ''}`;
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
                {(effectiveProduct === 'composite' || effectiveProduct === 'reflectivity') && ['5', '15', '25', '35', '45', '55', '65', '75 dBZ'].map(t => <span key={t}>{t}</span>)}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Layer opacity</span>
                <span className="font-mono text-[11px] text-wx-fg">{opacity}%</span>
              </div>
              <input type="range" min={20} max={100} step={2} value={opacity} onChange={(e) => setOpacity(parseInt(e.target.value))} className="w-full" />
            </div>

            <div>
              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Mode</div>
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
                  {hiRes && (
                    <>
                      <label className="flex items-center justify-between cursor-pointer mt-2.5 pt-2.5 border-t border-wx-line/40">
                        <div>
                          <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">PNG fallback</div>
                          <div className="text-[10px] text-wx-mute">Faster, no pointer dBZ</div>
                        </div>
                        <button
                          onClick={() => setPngFallback(!pngFallback)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${pngFallback ? 'bg-wx-accent' : 'bg-wx-line'}`}
                          aria-pressed={pngFallback}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${pngFallback ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                        </button>
                      </label>
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
                                className={`px-1.5 py-1 rounded text-[10px] font-mono border transition ${active ? 'bg-wx-accent text-black border-wx-accent' : 'bg-wx-ink border-wx-line text-wx-mute hover:text-wx-fg'}`}
                                title={nearest ? `nearest sweep: ${formatElev(nearest.elevation_deg)} (idx ${nearest.index})` : 'awaiting volume metadata'}
                              >
                                {formatElev(deg)}
                              </button>
                            );
                          })}
                          <button
                            onClick={() => setSelectedElevation('composite')}
                            className={`col-span-4 px-1.5 py-1 rounded text-[10px] font-mono border transition ${isComposite ? 'bg-wx-accent text-black border-wx-accent' : 'bg-wx-ink border-wx-line text-wx-mute hover:text-wx-fg'}`}
                            title="Max reflectivity across all tilts"
                          >
                            COMPOSITE · ALL TILTS
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                  {hiRes && level2Loading && <p className="text-[10px] text-wx-mute mt-1">Rendering…</p>}
                  {hiRes && level2Error === 'renderer_not_configured' && <p className="text-[10px] text-wx-danger mt-1">Renderer not configured</p>}
                  {hiRes && level2Error === 'renderer_waking' && <p className="text-[10px] text-wx-mute mt-1">Renderer waking up…</p>}
                  {hiRes && (level2Error === 'renderer_unreachable' || level2Error === 'renderer_timeout') && <p className="text-[10px] text-wx-mute mt-1">Renderer slow — retrying…</p>}
                  {hiRes && level2Error && !['renderer_not_configured','renderer_waking','renderer_unreachable','renderer_timeout'].includes(level2Error) && <p className="text-[10px] text-wx-danger mt-1">Level II error: {level2Error}</p>}
                  {hiRes && level2Overlay && !level2Loading && (
                    <p className="text-[10px] text-wx-mute mt-1">
                      Scan {new Date(level2Overlay.scan_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} UTC
                    </p>
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                  Subscribers · {subsCount}
                </div>
                <button
                  onClick={() => setShowSubs((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showSubs ? 'bg-sky-400' : 'bg-wx-line'}`}
                  aria-pressed={showSubs}
                  title={showSubs ? 'Hide subscriber pins' : 'Show subscriber pins'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showSubs ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <p className="text-[10px] text-wx-mute mb-3">
                {subsCount === 0
                  ? 'No active subscribers with a known location yet.'
                  : showSubs ? 'Cyan dots are active subscribers. Click a pin to open their profile.' : 'Pins hidden.'}
              </p>

              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Active warnings · {warnings.length}</div>
              <div className="flex flex-col gap-1">
                {warnings.slice(0, 5).map((w) => (
                  <button key={w.id} onClick={() => focusWarning(w)} className="flex items-center gap-2 p-2 rounded-lg bg-wx-ink border border-wx-line text-left hover:border-wx-accent">
                    <span className={`px-1.5 py-0.5 text-[9px] rounded ${w.type === 'tornado' ? 'bg-red-500/20 text-red-300' : w.type === 'severe' ? 'bg-orange-500/20 text-orange-300' : w.type === 'flood' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-500/20 text-slate-300'}`}>{w.type.toUpperCase()}</span>
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-semibold truncate">{w.label.split('·')[1]?.trim() || w.event}</div>
                      <div className="text-[10px] text-wx-mute">Until {w.expires_at ? new Date(w.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'}</div>
                    </div>
                  </button>
                ))}
                {warnings.length === 0 && <p className="text-[11px] text-wx-mute">No active warnings.</p>}
              </div>
            </div>

            <div>
              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Pointer</div>
              <div className="space-y-0.5 text-[11px] font-mono">
                <div className="flex justify-between"><span className="text-wx-mute">Lat</span><span>{hoverPixel ? hoverPixel.lat.toFixed(4) : '—'}</span></div>
                <div className="flex justify-between"><span className="text-wx-mute">Lon</span><span>{hoverPixel ? hoverPixel.lng.toFixed(4) : '—'}</span></div>
                <div className="flex justify-between"><span className="text-wx-mute">Sample</span><span className={hoverPixel && hoverPixel.sample != null ? 'text-wx-accent' : 'text-wx-mute'}>{sampleLabel}</span></div>
              </div>
            </div>
          </div>
        )}

        {selection && (
          <div className="absolute bottom-4 left-4 w-[320px] p-5 bg-wx-card border border-wx-line rounded-xl z-30">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-[0.06em] text-wx-mute font-semibold">Audience in area</div>
                <div className="text-[30px] font-extrabold leading-none mt-1">{previewCount ?? '—'}</div>
              </div>
              <button onClick={cancelDraw} className="w-8 h-8 inline-flex items-center justify-center"><Trash2 size={14} /></button>
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

        {/* Timeline — drag to scrub, space to play, arrows to step. */}
        {useRainViewer && totalFrames > 1 && (() => {
          const nowIdx = Math.max(0, rvPastCount - 1);
          const nowPct = (nowIdx / Math.max(1, totalFrames - 1)) * 100;
          const headPct = (frame / Math.max(1, totalFrames - 1)) * 100;
          const hoverFrameTime =
            hoverFrame != null && rvAllFrames[hoverFrame] ? rvAllFrames[hoverFrame].time : null;
          const nowSec = Math.floor(Date.now() / 1000);
          // Hour-grid labels (e.g. -2h / -1h / NOW / +30m). We snap to the
          // frame closest to each marker time so the label sits on a tick.
          const labelMinutes: { mins: number; label: string }[] = [
            { mins: -120, label: '−2h' },
            { mins: -60, label: '−1h' },
            { mins: -30, label: '−30m' },
            { mins: 0, label: 'NOW' },
            { mins: 30, label: '+30m' },
          ];
          const labels = labelMinutes
            .map(({ mins, label }) => {
              const target = nowSec + mins * 60;
              const idx = rvAllFrames.reduce(
                (best, f, i) => Math.abs(f.time - target) < Math.abs(rvAllFrames[best].time - target) ? i : best,
                0,
              );
              const diff = Math.abs(rvAllFrames[idx].time - target);
              if (diff > 20 * 60) return null;
              return { idx, label };
            })
            .filter((x): x is { idx: number; label: string } => x != null);

          return (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[min(880px,calc(100%-380px))] min-w-[520px] z-30">
              <div className="bg-wx-card border border-wx-line rounded-xl px-4 py-3.5 flex items-center gap-3.5">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setPlaying(false); setFrame((f) => Math.max(0, f - 1)); }}
                    className="w-7 h-9 grid place-items-center text-wx-mute hover:text-wx-fg"
                    title="Previous frame (←)"
                    aria-label="Previous frame"
                  >‹</button>
                  <button
                    onClick={() => setPlaying((p) => !p)}
                    className="w-9 h-9 rounded-lg bg-wx-accent text-black grid place-items-center hover:bg-amber-300"
                    title={playing ? 'Pause (space)' : 'Play (space)'}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button
                    onClick={() => { setPlaying(false); setFrame((f) => Math.min(totalFrames - 1, f + 1)); }}
                    className="w-7 h-9 grid place-items-center text-wx-mute hover:text-wx-fg"
                    title="Next frame (→)"
                    aria-label="Next frame"
                  >›</button>
                </div>

                <div className="flex-1 flex flex-col gap-1.5">
                  <div
                    ref={trackRef}
                    className="relative h-7 cursor-pointer select-none"
                    onMouseDown={(e) => {
                      draggingRef.current = true;
                      setPlaying(false);
                      const f = scrubAtClientX(e.clientX);
                      if (f != null) setFrame(f);
                    }}
                    onMouseMove={(e) => {
                      const f = scrubAtClientX(e.clientX);
                      if (f != null) setHoverFrame(f);
                    }}
                    onMouseLeave={() => setHoverFrame(null)}
                  >
                    {/* Past + nowcast bands */}
                    <div className="absolute left-0 right-0 top-1/2 h-1.5 bg-wx-line rounded-sm overflow-hidden -translate-y-1/2">
                      <div className="absolute left-0 top-0 bottom-0 bg-wx-ok/70" style={{ width: `${nowPct}%` }} />
                      {rvAllFrames.length > rvPastCount && (
                        <div
                          className="absolute right-0 top-0 bottom-0 bg-[repeating-linear-gradient(45deg,rgba(251,191,36,0.10)_0_5px,rgba(251,191,36,0.28)_5px_10px)] border-l border-amber-500/60"
                          style={{ width: `${100 - nowPct}%` }}
                        />
                      )}
                    </div>

                    {/* Frame ticks */}
                    <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between px-0.5 pointer-events-none">
                      {rvAllFrames.map((_, i) => (
                        <div
                          key={i}
                          className={`w-[1.5px] rounded ${
                            i === nowIdx ? 'h-4 bg-wx-accent' :
                            i === 0 || i === totalFrames - 1 ? 'h-3 bg-wx-mute/70' :
                            'h-[7px] bg-wx-mute/50'
                          }`}
                        />
                      ))}
                    </div>

                    {/* Hover ghost head */}
                    {hoverFrame != null && hoverFrame !== frame && (
                      <div
                        className="absolute top-1/2 w-[10px] h-[10px] rounded-full bg-wx-mute/60 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                        style={{ left: `${(hoverFrame / Math.max(1, totalFrames - 1)) * 100}%` }}
                      />
                    )}

                    {/* Active head */}
                    <div
                      className="absolute top-1/2 w-[14px] h-[14px] rounded-full bg-wx-accent border-2 border-wx-ink -translate-x-1/2 -translate-y-1/2 pointer-events-none shadow"
                      style={{ left: `${headPct}%` }}
                    />

                    {/* Hover timestamp tooltip */}
                    {hoverFrame != null && hoverFrameTime != null && (
                      <div
                        className="absolute -top-7 px-1.5 py-0.5 rounded bg-wx-ink border border-wx-line text-[10px] font-mono whitespace-nowrap pointer-events-none -translate-x-1/2"
                        style={{ left: `${(hoverFrame / Math.max(1, totalFrames - 1)) * 100}%` }}
                      >
                        {new Date(hoverFrameTime * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    )}
                  </div>

                  {/* Time-axis labels under the track */}
                  <div className="relative h-3 select-none pointer-events-none">
                    {labels.map(({ idx, label }) => (
                      <span
                        key={label}
                        className={`absolute -translate-x-1/2 text-[9.5px] font-mono ${label === 'NOW' ? 'text-wx-accent font-semibold' : 'text-wx-mute'}`}
                        style={{ left: `${(idx / Math.max(1, totalFrames - 1)) * 100}%` }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-0.5 min-w-[96px]">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold tracking-wider uppercase ${isForecastFrame ? 'border-wx-accent text-wx-accent' : 'border-wx-line text-wx-fg'}`}>
                    {isForecastFrame ? 'NOWCAST' : 'OBSERVED'}
                  </span>
                  <span className="text-[15px] font-bold tabular-nums">{frameTimeLabel}</span>
                  <span className="text-[11px] text-wx-mute tabular-nums">{relLabel}</span>
                </div>

                <button
                  onClick={() => {
                    const order: ('0.5x' | '1x' | '2x' | '4x')[] = ['0.5x', '1x', '2x', '4x'];
                    setSpeed(order[(order.indexOf(speed) + 1) % order.length]);
                  }}
                  className="text-[11px] px-2.5 py-1.5 border border-wx-line rounded-md hover:border-wx-accent font-mono tabular-nums"
                  title="Cycle playback speed"
                >
                  {speed}
                </button>
              </div>
              <div className="text-[10px] text-wx-mute text-center mt-1.5 font-mono">
                Space play/pause · ← → step · Home/End · N to jump to NOW
              </div>
            </div>
          );
        })()}

        {!useRainViewer && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30">
            <div className="bg-wx-card border border-wx-line rounded-xl px-4 py-2 text-[11px] text-wx-mute">
              Live frame · {frameTimeLabel}
            </div>
          </div>
        )}

        {hoverPixel && (
          <div className="absolute bottom-4 right-4 font-mono text-[11px] bg-wx-card border border-wx-line rounded-md px-2.5 py-1.5 z-20">
            <span className="text-wx-mute">lat</span> {hoverPixel.lat.toFixed(3)} <span className="text-wx-mute">lon</span> {hoverPixel.lng.toFixed(3)} <span className="text-wx-mute">· </span>{sampleLabel}
          </div>
        )}

        <div className="absolute inset-0 pointer-events-none z-10">
          {Object.keys(RADAR_SITES).map((code) => {
            const site = RADAR_SITES[code];
            const isActive = selectedSite === code;
            const p = screenPoint(site.center);
            if (!p) return null;
            return (
              <div key={code} className="absolute pointer-events-auto" style={{ left: p.x, top: p.y, transform: 'translate(-50%, -100%)' }}>
                {isActive && <div className="absolute left-1/2 top-full -translate-x-1/2 -translate-y-1/2 w-[230px] h-[230px] rounded-full border border-dashed border-white/10" style={{ background: 'radial-gradient(circle, rgba(251,191,36,0.06) 0%, transparent 70%)' }} />}
                <button onClick={() => { mapRef.current?.flyTo({ center: site.center, zoom: site.zoom, duration: 700 }); setSelectedSite(code); }} className={`inline-flex items-center gap-1.5 px-2.5 py-1 bg-wx-card border border-wx-line rounded-lg text-[11px] font-semibold ${isActive ? 'bg-wx-accent text-black border-wx-accent' : 'hover:border-wx-accent'}`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-wx-mute" /> {code} <span className="opacity-60 font-medium text-[10px]">{site.name.split(' ').pop()}</span>
                </button>
              </div>
            );
          })}
        </div>

        {hoverSub && (
          <div
            className="absolute z-50 bg-wx-card border border-wx-line rounded-lg px-2.5 py-2 text-[11px] pointer-events-none shadow-lg max-w-[240px]"
            style={{ left: hoverPos.x + 12, top: hoverPos.y - 20 }}
          >
            <div className="font-semibold text-wx-fg">{hoverSub.name || 'Subscriber'}</div>
            <div className="text-[10px] text-wx-mute">
              {hoverSub.zip ? `ZIP ${hoverSub.zip}` : ''}
              {hoverSub.telegram_username ? ` · @${hoverSub.telegram_username}` : ''}
            </div>
            {hoverSub.current_address && (
              <div className="text-[10px] text-wx-accent mt-0.5">
                📍 At: {hoverSub.current_address}
              </div>
            )}
            {!hoverSub.current_address && hoverSub.home_address && (
              <div className="text-[10px] text-wx-mute mt-0.5 truncate">
                Home: {hoverSub.home_address}
              </div>
            )}
            <div className="font-mono text-[10px] text-wx-mute mt-1">
              {hoverPixel?.lat.toFixed(3)}, {hoverPixel?.lng.toFixed(3)}
            </div>
            <div className="text-[9.5px] text-wx-mute mt-1">Click to open profile</div>
          </div>
        )}
      </div>
    </div>
  );
}
