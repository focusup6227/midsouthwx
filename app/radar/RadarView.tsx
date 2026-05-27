'use client';

// Patches mapbox-gl 3.24's removeSource() to swallow a known terrain-race
// crash on Source unmount. Must run before any <Map> renders — keep this
// import at the very top of the module so it's evaluated first.
import '@/lib/mapbox/patch-remove-source';

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Map, { Source, Layer, type MapMouseEvent, type MapRef } from 'react-map-gl';
import mapboxgl from 'mapbox-gl';
import {
  AnnotationLayer,
  AnnotationToolbar,
  useRadarAnnotations,
} from './_components/RadarAnnotations';
import { supabaseBrowser } from '@/lib/supabase/client';
import { mapboxAccessToken, mapboxStyleUrl } from '@/lib/supabase/env';
import {
  CloudLightning, Radio, Wind, Atom, RotateCw, Satellite,
  Play, Pause, Trash2, Send, Target, Search, X,
  ChevronLeft, ChevronRight, ChevronDown, Eye, EyeOff, MousePointer2,
} from 'lucide-react';
import {
  NEXRAD_SITES,
  NEXRAD_SITES_BY_CODE,
  nearestSites,
  searchSites,
  distanceKm,
  type RadarSite,
} from '@/lib/radar/sites';
import { alertTint, categoryBadge, type NwsRadarAlert } from '@/lib/nws/radar';
import { STORM_TRACK_LINE_COLOR } from '@/lib/nws/storm-tracks';
import {
  useWarnings,
  useLsr,
  useSpc,
  useSubs,
  useMrmsLatest,
  useMrmsMesh,
  useCapWarnings,
  useLightning,
  useCouplets,
  useMetar,
  useMping,
  WARNINGS_KEY,
} from './_hooks/useRadarData';
import { useSWRConfig } from 'swr';
import AfdPanel from './_components/AfdPanel';
import { parseRadarUrl, useRadarUrlSync } from './_hooks/useRadarUrlState';
import { MODEL_OVERLAYS, DISABLED_MODELS, type ModelOverlayKey } from '@/lib/radar/models';

// Three providers, picked per product based on which one actually publishes that
// product as a public tile feed:
//   - LibreWxR (api.librewxr.net) — RainViewer-compatible v2 API. CONUS composite
//     reflectivity with real past frames (2h history at 10 min intervals + nowcast).
//     Drives the timeline. Data CC-BY-4.0 LibreWxR.
//   - NOAA NCEP GeoServer (opengeo.ncep.noaa.gov) — per-site reflectivity / velocity.
//     Single-frame ("NOW") because NCEP doesn't expose history.
//   - UCAR THREDDS ncWMS (thredds.ucar.edu) — MRMS Az-Shear 0-2km AGL rotation.
//     Composite-only; resolves the latest dataset URL through /api/radar/mrms-latest.
//   - Fly.io Level II renderer — single-site Correlation Coefficient (ρhv) and the
//     Hi-Res reflectivity/velocity options.
type ProductKey = 'composite' | 'reflectivity' | 'velocity' | 'correlation' | 'rotation' | 'satellite';

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
  satellite:    { label: 'Satellite (IR cloud)',   short: 'SAT',  modes: { composite: true,  site: false }, icon: Satellite },
};

// LibreWxR color schemes (color path param 1..9). Default 8 matches radar.weather.gov.
const LIBREWXR_COLOR_SCHEMES: { id: number; name: string }[] = [
  { id: 1, name: 'Black and White' },
  { id: 2, name: 'Original' },
  { id: 3, name: 'Universal Blue' },
  { id: 4, name: 'TITAN' },
  { id: 5, name: 'The Weather Channel' },
  { id: 6, name: 'Meteored' },
  { id: 7, name: 'NEXRAD Level III' },
  { id: 8, name: 'NWS Reflectivity' },
  { id: 9, name: 'Dark Sky' },
];

// Live GOES-East ABI tile sources from two upstream providers:
//
//   - NASA GIBS (gibs.earthdata.nasa.gov) — WMTS. Six layers verified against
//     GetCapabilities: Band13 IR · GeoColor · Band2 Red Vis · Air Mass · Dust
//     · FireTemp. Tile path /{Identifier}/default/default/{TileMatrixSet}/
//     {z}/{y}/{x}.png — note WMTS uses {z}/{y}/{x}, inverse of slippy maps.
//     maxzoom matches the matrix set level; Mapbox overzooms past that.
//   - Iowa State Mesonet (mesonet.agron.iastate.edu) — slippy TMS. Fills the
//     GIBS gap with all three Water Vapor bands. Tile path
//     /cache/tile.py/1.0.0/{channel}/{z}/{x}/{y}.png. Always "latest" frame,
//     ~10-15 min cadence.
const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const IEM_BASE = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0';
type GoesSourceId =
  | 'goes-cleanir'
  | 'goes-geocolor'
  | 'goes-visible'
  | 'goes-airmass'
  | 'goes-dust'
  | 'goes-firetemp'
  | 'iem-wv-upper'
  | 'iem-wv-mid'
  | 'iem-wv-lower';
type SatSourceId = 'lwxr' | GoesSourceId;
type GoesLegend = 'ir' | 'wv' | 'rgb';
type SatProvider = 'gibs' | 'iem';
const GOES_SOURCES: Record<GoesSourceId, {
  label: string;
  short: string;
  provider: SatProvider;
  layer: string;       // GIBS layer Identifier OR IEM channel name
  matrix: string;      // GIBS matrix set; '' for IEM
  maxzoom: number;
  legend: GoesLegend;
}> = {
  'goes-cleanir':  { label: 'GOES Clean IR (B13)',          short: 'IR',    provider: 'gibs', layer: 'GOES-East_ABI_Band13_Clean_Infrared',  matrix: 'GoogleMapsCompatible_Level6', maxzoom: 6, legend: 'ir'  },
  'goes-geocolor': { label: 'GOES GeoColor',                short: 'COLOR', provider: 'gibs', layer: 'GOES-East_ABI_GeoColor',               matrix: 'GoogleMapsCompatible_Level7', maxzoom: 7, legend: 'rgb' },
  'goes-visible':  { label: 'GOES Red Visible (B2)',        short: 'VIS',   provider: 'gibs', layer: 'GOES-East_ABI_Band2_Red_Visible_1km',  matrix: 'GoogleMapsCompatible_Level7', maxzoom: 7, legend: 'ir'  },
  'goes-airmass':  { label: 'GOES Air Mass RGB',            short: 'AIR',   provider: 'gibs', layer: 'GOES-East_ABI_Air_Mass',               matrix: 'GoogleMapsCompatible_Level6', maxzoom: 6, legend: 'rgb' },
  'goes-dust':     { label: 'GOES Dust RGB',                short: 'DUST',  provider: 'gibs', layer: 'GOES-East_ABI_Dust',                   matrix: 'GoogleMapsCompatible_Level7', maxzoom: 7, legend: 'rgb' },
  'goes-firetemp': { label: 'GOES Fire Temperature',        short: 'FIRE',  provider: 'gibs', layer: 'GOES-East_ABI_FireTemp',               matrix: 'GoogleMapsCompatible_Level7', maxzoom: 7, legend: 'rgb' },
  'iem-wv-upper':  { label: 'GOES Upper-Level WV (B8)',     short: 'WV8',   provider: 'iem',  layer: 'goes_east_conus_ch08',                 matrix: '',                            maxzoom: 8, legend: 'wv'  },
  'iem-wv-mid':    { label: 'GOES Mid-Level WV (B9, SPC)',  short: 'WV9',   provider: 'iem',  layer: 'goes_east_conus_ch09',                 matrix: '',                            maxzoom: 8, legend: 'wv'  },
  'iem-wv-lower':  { label: 'GOES Lower-Level WV (B10)',    short: 'WV10',  provider: 'iem',  layer: 'goes_east_conus_ch10',                 matrix: '',                            maxzoom: 8, legend: 'wv'  },
};
const satTileUrl = (cfg: typeof GOES_SOURCES[GoesSourceId], cacheKey: number) =>
  cfg.provider === 'iem'
    ? `${IEM_BASE}/${cfg.layer}/{z}/{x}/{y}.png?_t=${cacheKey}`
    : `${GIBS_BASE}/${cfg.layer}/default/default/${cfg.matrix}/{z}/{y}/{x}.png?_t=${cacheKey}`;

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

// LibreWxR Weather Maps API (drop-in for RainViewer v2). Returns 2h of past
// frames + nowcast. Color scheme 8 = NWS Reflectivity (matches radar.weather.gov
// palette). Options "1_1" = smoothed + snow-aware. 512px tiles double the spatial
// resolution at the same z (max zoom 7), so the imagery stays readable down to
// the city block at z~11.
const LIBREWXR_INDEX_URL = 'https://api.librewxr.net/public/weather-maps.json';
const LIBREWXR_COLOR = 8;
const LIBREWXR_OPTS = '1_1';
const LIBREWXR_TILE_SIZE = 512;
const LIBREWXR_MAX_ZOOM = 7;

// Default fly-to when the operator first switches from CONUS → single site
// (and no site has been chosen yet). KNQA = Memphis, the home office.
const DEFAULT_SITE_CODE = 'KNQA';

// Cap geographic map pills by zoom — kept aggressive so dense areas (TX, OK)
// don't carpet the map. Past z8 every site in view shows.
function mapPillCapForZoom(zoom: number): number {
  if (zoom >= 8) return Infinity;
  if (zoom >= 7) return 24;
  if (zoom >= 6) return 12;
  if (zoom >= 5) return 6;
  return 0;
}

function sitePillId(code: string): string {
  return code.replace(/^K/, '');
}

function sitePillLabel(site: RadarSite, zoom: number): string {
  const id = sitePillId(site.code);
  if (zoom >= 8) {
    const city = site.name.split(/[\s(/]/)[0];
    return `${id} · ${city}`;
  }
  return id;
}

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

// Baron256 reflectivity palette (~/Downloads/Baron256.pal). Each pair of
// (val, color) stops below is a *boundary* between Baron's hardcoded gradient
// bands — the e.g. 14.99/15 pair forces a hard color jump from the end of one
// band (light blue) to the start of the next (light green), matching how
// Baron's display steps colors at every 5 dBZ band.
const REFL_STOPS: [number, string][] = [
  [5,     '#105F90'], [14.99, '#1FBFFF'],
  [15,    '#1FDF70'], [34.99, '#005000'],
  [35,    '#FFFF1F'], [44.99, '#FFAF00'],
  [45,    '#FF0000'], [54.99, '#C00000'],
  [55,    '#DF00DF'], [64.99, '#AF00AF'],
  [65,    '#000000'], [80,    '#FFFFFF'],
];
// ALPHA-Velo palette (~/Downloads/ALPHA-Velo.pal). Original is in knots with
// scale=1.9426 m/s per knot; converted here to m/s so the stops compare
// directly against the renderer's raw velocity values (Py-ART m/s).
//   -120 kts → -61.78 m/s   #00009B   deep blue (strongest inbound)
//    -50 kts → -25.74 m/s   #00FFFF   cyan
//    -10 kts →  -5.15 m/s   #006600   dark green (slow inbound)
//      0 kts →   0.00 m/s   #808080   gray (zero / clutter)
//     10 kts →   5.15 m/s   #600D17   dark red-brown (slow outbound)
//     30 kts →  15.44 m/s   #C80000   red
//     60 kts →  30.89 m/s   #FFFF00   yellow
//    120 kts →  61.78 m/s   #783C00   brown (strongest outbound)
const VEL_STOPS: [number, string][] = [
  [-61.78, '#00009B'],
  [-25.74, '#00FFFF'],
  [ -5.15, '#006600'],
  [  0.00, '#808080'],
  [  5.15, '#600D17'],
  [ 15.44, '#C80000'],
  [ 30.89, '#FFFF00'],
  [ 61.78, '#783C00'],
];
// kk.pal correlation coefficient (~/Downloads/kk.pal). Smooth interpolation
// between solid stops; the renderer masks gates with v < 0.2 so the lower
// end (white→black) only kicks in for low-quality gates that scraped past
// the mask. Note: at 0.99 the file specifies the same color for both ends
// of the gradient pair, i.e. a solid #8B1E4D band — Mapbox's linear lerp
// renders that as a brief plateau between 0.97 (red) and 1.00 (pink).
const CC_STOPS: [number, string][] = [
  [0.00, '#FFFFFF'],
  [0.45, '#000000'],
  [0.60, '#0A0ABE'],
  [0.75, '#7878FF'],
  [0.80, '#5FF564'],
  [0.85, '#87D70A'],
  [0.90, '#FFFF00'],
  [0.95, '#FF8C00'],
  [0.97, '#E10300'],
  [0.99, '#8B1E4D'],
  [1.00, '#FFB4D7'],
  [1.05, '#A43696'],
];

function buildFillColorExpr(product: 'refl' | 'vel' | 'cc', _vmin: number, _vmax: number): any {
  // The renderer stores raw values in properties.v (dBZ for refl, m/s for vel,
  // dimensionless for cc), so the interpolate stops compare against raw scale
  // too. (Earlier code normalized to a 0–255 byte scale to match the original
  // PNG renderer's quantization — no longer applicable now that we use
  // GeoJSON polygons with real values.)
  const stops = product === 'refl' ? REFL_STOPS : product === 'vel' ? VEL_STOPS : CC_STOPS;
  const out: any[] = ['interpolate', ['linear'], ['get', 'v']];
  let lastQ = -Infinity;
  for (const [val, hex] of stops) {
    let q = val;
    if (q <= lastQ) q = lastQ + 0.0001;
    out.push(q, hex);
    lastQ = q;
  }
  return out;
}

function buildFillOpacityExpr(product: 'refl' | 'vel' | 'cc', userOpacity: number,
                              _vmin: number, _vmax: number): any {
  if (product !== 'refl') return userOpacity;
  // Light rain (5 dBZ) shows at half opacity; full opacity by 20 dBZ. Below
  // 5 dBZ the renderer already masks gates out, so this ramp only affects the
  // 5–20 fade-in band.
  return [
    'interpolate', ['linear'], ['get', 'v'],
    5,  0.5 * userOpacity,
    20, userOpacity,
  ];
}

function formatElev(deg: number): string {
  return `${deg.toFixed(deg < 10 ? 1 : 0)}°`;
}

type NwsWarning = NwsRadarAlert;

type AudienceBreakdown = { total: number; tn: number; ms: number; ar: number; other: number };

type LibreWxRFrame = { time: number; path: string };
type LibreWxRIndex = {
  host: string;
  radar: { past: LibreWxRFrame[]; nowcast: LibreWxRFrame[] };
  satellite: { infrared: LibreWxRFrame[] };
};

// Stable paint objects for the selection / draw layers — these never change,
// so hoisting them out of render eliminates a fresh paint diff on every render.
const SEL_POLY_FILL_PAINT: any = { 'fill-color': '#fbbf24', 'fill-opacity': 0.12 };
const SEL_POLY_LINE_PAINT: any = { 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [2, 1] };

// GLM lightning: each flash lives 2 min on screen. Opacity 1 at strike time,
// linearly to 0 at fadeMs. nowMs is rebound imperatively at 1 Hz below.
const LIGHTNING_FADE_MS = 120_000;
const LIGHTNING_BOLT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="48" height="72"><path d="M14 0 L0 22 L9 22 L7 36 L24 12 L13 12 L18 0 Z" fill="#fde047" stroke="#0b1220" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

// F2: preferred order for the compose body seed when launching from a
// warning: AI summary → headline → truncated description → null. The radar
// warnings endpoint doesn't return description today, so headline is the
// realistic last resort.
function CategoryCheckbox({
  label,
  tint,
  on,
  toggle,
  count,
}: {
  label: string;
  tint: string;
  on: boolean;
  toggle: () => void;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex items-center justify-between gap-1.5 text-left"
      aria-pressed={on}
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <span
          className={`inline-flex h-3 w-3 items-center justify-center rounded border ${
            on ? 'border-wx-accent bg-wx-accent/20 text-wx-accent' : 'border-wx-line text-transparent'
          }`}
        >
          {on ? '✓' : ''}
        </span>
        <span className={on ? tint : 'text-wx-mute'}>{label}</span>
      </span>
      <span className="text-wx-mute font-mono">{count}</span>
    </button>
  );
}

// Small top-of-map banner shown on first load if any required env var is
// missing. Listed by name + short rationale so the operator knows what's
// broken without digging into logs. Dismiss is per-session (sessionStorage).
function EnvPreflightBanner({ items }: { items: string[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 max-w-[680px] px-3 py-2 rounded-lg border border-red-500 bg-red-500/15 backdrop-blur-sm shadow-lg text-red-200 text-[11.5px] flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-bold tracking-wider uppercase text-[10px] text-red-300">
          Radar environment incomplete
        </div>
        <ul className="mt-1 space-y-0.5 list-disc list-inside">
          {items.map((m, i) => (
            <li key={i} className="text-red-200/90">{m}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-red-300 hover:text-red-200"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function warningBodySeed(w: NwsRadarAlert): string | null {
  if (w.ai_summary && w.ai_summary.trim()) return w.ai_summary.trim();
  if (w.headline && w.headline.trim()) return w.headline.trim();
  return null;
}

// F7: SPC categorical-outlook palette. The convention (and SPC's own map)
// goes light-green → green → yellow → orange → red → magenta as risk
// escalates from general thunderstorms to a HIGH risk day. Each feature's
// `properties.LABEL` is the short code (TSTM / MRGL / SLGT / ENH / MDT / HIGH).
const SPC_FILL_EXPR: any = [
  'match',
  ['get', 'LABEL'],
  'TSTM', '#bbf7d0', // light green — general thunder
  'MRGL', '#86efac', // green — marginal
  'SLGT', '#fde047', // yellow — slight
  'ENH',  '#fb923c', // orange — enhanced
  'MDT',  '#ef4444', // red — moderate
  'HIGH', '#e879f9', // magenta — high
  '#94a3b8',
];
const SPC_LINE_EXPR: any = [
  'match',
  ['get', 'LABEL'],
  'TSTM', '#22c55e',
  'MRGL', '#16a34a',
  'SLGT', '#ca8a04',
  'ENH',  '#ea580c',
  'MDT',  '#b91c1c',
  'HIGH', '#a21caf',
  '#64748b',
];

// F4: hazard-keyed fill for LSR pins. Matches the warning-polygon palette
// so a tornado LSR reads the same color as a tornado warning, etc.
const LSR_FILL_EXPR: any = [
  'match',
  ['get', 'hazard'],
  'tornado', '#ef4444',
  'severe',  '#f97316',
  'flood',   '#10b981',
  'winter',  '#38bdf8',
  'wind',    '#a855f7',
  'heat',    '#facc15',
  '#94a3b8',
];

// All LibreWxR frame layers mount opacity 0. The "current" frame is bumped
// up imperatively in the playback effect; reusing this single paint object
// across all 30+ frames means react-map-gl doesn't diff a new paint every
// tick. 'linear' resampling smooths the over-scaled tiles past z7 instead of
// showing crunchy nearest-neighbor squares.
const LWXR_FRAME_PAINT: any = {
  'raster-opacity': 0,
  'raster-fade-duration': 0,
  'raster-resampling': 'linear',
  // LibreWxR composite tiles are pretty dim out of the box. Saturate +
  // contrast so the green/yellow/red reads as bright as observed radar.
  'raster-saturation': 0.35,
  'raster-contrast': 0.2,
};

const WARNING_FILL_EXPR: any = [
  'case',
  ['all', ['==', ['get', 'category'], 'warning'], ['==', ['get', 'hazard'], 'tornado']],
  'rgba(239,68,68,0.28)',
  ['all', ['==', ['get', 'category'], 'warning'], ['==', ['get', 'hazard'], 'severe']],
  'rgba(249,115,22,0.24)',
  ['all', ['==', ['get', 'category'], 'warning'], ['==', ['get', 'hazard'], 'flood']],
  'rgba(16,185,129,0.22)',
  ['all', ['==', ['get', 'category'], 'warning'], ['==', ['get', 'hazard'], 'winter']],
  'rgba(56,189,248,0.22)',
  ['==', ['get', 'category'], 'warning'],
  'rgba(251,191,36,0.20)',
  ['all', ['==', ['get', 'category'], 'watch'], ['==', ['get', 'hazard'], 'tornado']],
  'rgba(250,204,21,0.14)',
  ['==', ['get', 'category'], 'watch'],
  'rgba(250,204,21,0.10)',
  ['==', ['get', 'category'], 'advisory'],
  'rgba(167,139,250,0.16)',
  ['==', ['get', 'category'], 'discussion'],
  'rgba(217,70,239,0.20)',
  // Statements (incl. Special Weather Statements for hail) at higher opacity
  // than before — they used to nearly disappear over bright radar pixels.
  ['==', ['get', 'category'], 'statement'],
  'rgba(148,163,184,0.22)',
  'rgba(148,163,184,0.12)',
];

const WARNING_LINE_EXPR: any = [
  'case',
  ['all', ['==', ['get', 'category'], 'warning'], ['==', ['get', 'hazard'], 'tornado']],
  '#ef4444',
  ['all', ['==', ['get', 'category'], 'warning'], ['==', ['get', 'hazard'], 'severe']],
  '#f97316',
  ['all', ['==', ['get', 'category'], 'warning'], ['==', ['get', 'hazard'], 'flood']],
  '#10b981',
  ['all', ['==', ['get', 'category'], 'warning'], ['==', ['get', 'hazard'], 'winter']],
  '#38bdf8',
  ['==', ['get', 'category'], 'warning'],
  '#fbbf24',
  ['all', ['==', ['get', 'category'], 'watch'], ['==', ['get', 'hazard'], 'tornado']],
  '#facc15',
  ['==', ['get', 'category'], 'watch'],
  '#eab308',
  ['==', ['get', 'category'], 'advisory'],
  '#a78bfa',
  ['==', ['get', 'category'], 'discussion'],
  '#d946ef',
  ['==', ['get', 'category'], 'statement'],
  '#94a3b8',
  '#64748b',
];

// Stable paint objects for the warning fill + line layers. selectedWarning
// drives line-width imperatively via setPaintProperty in an effect below so
// react-map-gl doesn't re-diff the whole paint object every time a different
// warning is clicked.
const WARNING_FILL_PAINT: any = {
  'fill-color': WARNING_FILL_EXPR,
  'fill-opacity': 0.9,
};
const WARNING_LINE_PAINT: any = {
  'line-color': WARNING_LINE_EXPR,
  'line-width': 2,
  'line-opacity': 0.9,
};
const WARNING_LINE_WATCH_PAINT: any = {
  'line-color': WARNING_LINE_EXPR,
  'line-width': 2,
  'line-opacity': 0.85,
  'line-dasharray': [2, 1.5],
};
// SPC Mesoscale Discussions: longer dash with smaller gap so MCDs read as
// "concern outlook" outline rather than an active warning. Fuchsia hue comes
// from WARNING_LINE_EXPR's discussion branch.
const WARNING_LINE_DISCUSSION_PAINT: any = {
  'line-color': WARNING_LINE_EXPR,
  'line-width': 1.8,
  'line-opacity': 0.9,
  'line-dasharray': [4, 2],
};

type SpcDayInitial = {
  day_number: number;
  geojson: GeoJSON.FeatureCollection;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  highest_label: string | null;
};

export type RadarViewProps = {
  initialSubsGeo?: GeoJSON.FeatureCollection;
  initialSpcDays?: SpcDayInitial[];
  initialWarnings?: {
    warnings: NwsRadarAlert[];
    geojson: GeoJSON.FeatureCollection;
    tracks: GeoJSON.FeatureCollection;
  };
  envWarnings?: string[];
};

export default function RadarView({ initialSubsGeo, initialSpcDays, initialWarnings, envWarnings }: RadarViewProps = {}) {
  // SWR-managed remote data. Dedupe, focus-revalidation off, retry-on-error
  // built in — replaces the manual polling effects + in-flight refs that
  // lived here before.
  const subsSwr = useSubs(initialSubsGeo);
  const subsGeo: any = subsSwr.data ?? { type: 'FeatureCollection', features: [] };
  const warningsSwr = useWarnings(initialWarnings);
  const warnings = (warningsSwr.data?.warnings ?? []) as NwsWarning[];
  const warningsGeo = (warningsSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const tracksGeo = (warningsSwr.data?.tracks ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const warningsLoading = warningsSwr.isValidating;
  const lsrSwr = useLsr();
  const lsrGeo = (lsrSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const spcSwr = useSpc(initialSpcDays);
  const mrmsSwr = useMrmsLatest();
  const mrmsUrlPath = mrmsSwr.data?.urlPath ?? null;
  const { mutate: swrMutate } = useSWRConfig();

  // Hydrate from URL once. RadarView is dynamic(ssr:false) so `window` is
  // always defined here. Subsequent state changes write back via
  // useRadarUrlSync below.
  const urlInitial = typeof window !== 'undefined' ? parseRadarUrl(window.location.search) : {};

  const [product, setProduct] = useState<ProductKey>(
    (urlInitial.product as ProductKey) ?? 'composite',
  );
  const [selectedSite, setSelectedSite] = useState<string | null>(urlInitial.site ?? null);
  const [hiRes, setHiRes] = useState(urlInitial.hiRes ?? true);
  const [pngFallback, setPngFallback] = useState(false);
  const [selectedElevation, setSelectedElevation] = useState<number | 'composite'>(0.5);
  const [level2Loading, setLevel2Loading] = useState(false);
  const [level2Error, setLevel2Error] = useState<string | null>(null);
  // Retry attempt number for the current Level II fetch (0 = first try). Lets
  // the inspector show "Warming renderer · 2/3" during the 4s/8s/12s backoff
  // schedule instead of going silent.
  const [level2Attempt, setLevel2Attempt] = useState(0);
  const level2MaxAttempts = 3;
  const [level2Overlay, setLevel2Overlay] = useState<Level2Overlay | null>(null);
  const [level2GeoJSON, setLevel2GeoJSON] = useState<any>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [drawMode, setDrawMode] = useState<'none' | 'polygon' | 'snap' | 'pick-site'>('none');
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  // 5 min buckets — NCEP base reflectivity itself only updates every ~4–6 min
  // (one full NEXRAD VCP), so anything faster just forces tile refetches for
  // identical imagery and tanks the buttery feel during pan/zoom.
  const [tileCacheKey, setTileCacheKey] = useState(() => Math.floor(Date.now() / 300_000));

  // LibreWxR index drives the timeline for CONUS composite mode AND for the
  // Satellite (IR) product.
  const [lwxrIndex, setLwxrIndex] = useState<LibreWxRIndex | null>(null);
  // LibreWxR storm-motion arrow overlay (radar tiles only — satellite ignores).
  const [showArrows, setShowArrows] = useState(urlInitial.showArrows ?? true);
  // LibreWxR color scheme (1..9 — see LIBREWXR_COLOR_SCHEMES). Radar tiles only.
  const [colorScheme, setColorScheme] = useState(urlInitial.colorScheme ?? 8);
  // Satellite source: LibreWxR modeled IR (animated) or a real GOES-East band
  // served single-frame live via NASA GIBS WMTS.
  const [satSource, setSatSource] = useState<SatSourceId>(
    (urlInitial.satSource as SatSourceId | undefined) ?? 'lwxr',
  );
  // CAP alert polygons (LibreWxR pipeline) as a secondary overlay alongside
  // the NWS warning polygons. Off by default — observation-only until
  // operator opts in.
  const [showCap, setShowCap] = useState(urlInitial.showCap ?? false);
  const capSwr = useCapWarnings(showCap);
  const capWarningsGeo = (capSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;

  const [opacity, setOpacity] = useState(urlInitial.opacity ?? 100);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<'0.5x' | '1x' | '2x' | '4x'>('1x');
  const [showNws, setShowNws] = useState(urlInitial.showNws ?? true);
  // Per-category gates under the master NWS toggle. All on by default. When
  // showNws is off the master overrides; when on, these whittle which polygon
  // types render on the map AND show up in the inspector list.
  const [catWarnings, setCatWarnings] = useState(true);
  const [catWatches, setCatWatches] = useState(true);
  const [catAdvisories, setCatAdvisories] = useState(true);
  const [catDiscussions, setCatDiscussions] = useState(true);
  const [showStormTracks, setShowStormTracks] = useState(urlInitial.showStormTracks ?? true);
  // F4: Local Storm Reports overlay. Pulled separately from warnings on a
  // gentler cadence (every 2 min) — LSRs filter in slowly as spotters call
  // them in, no need to refresh as aggressively as the warnings polygons.
  const [showLsr, setShowLsr] = useState(urlInitial.showLsr ?? true);
  // NWS forecast + fire zone outlines from /public/maps/nws-zones.geojson
  // (run `npm run gen:zones` to rebuild). Off by default — useful for
  // "which zone is this alert in" reference but visually busy when always
  // on.
  const [showZones, setShowZones] = useState(urlInitial.showZones ?? false);
  const [selectedLsr, setSelectedLsr] = useState<{
    id: string;
    event: string;
    hazard: string | null;
    magnitude: string | null;
    location: string | null;
    occurred_at: string | null;
    remark: string | null;
    source: string | null;
  } | null>(null);
  // F13: selected mPING report popover state.
  const [selectedMping, setSelectedMping] = useState<{
    id: number;
    description: string;
    hazard: string;
    obtime: string;
  } | null>(null);
  // F12: selected METAR station popover state.
  const [selectedMetar, setSelectedMetar] = useState<{
    icaoId: string;
    name: string | null;
    obsTime: string | null;
    temp: number | null;
    dewp: number | null;
    wdir: number | null;
    wspd: number | null;
    wgst: number | null;
    altim: number | null;
    wxString: string | null;
    rawOb: string | null;
  } | null>(null);
  // F9: selected NEXRAD velocity-couplet — popover shows shear, site, age,
  // and how many volume scans this rotation has been seen on. `lat`/`lon`
  // round-tripped from the GeoJSON so an "alert from this rotation" CTA
  // can pre-fill a compose with a tight circle around the point.
  const [selectedCouplet, setSelectedCouplet] = useState<{
    track_id: string;
    site: string;
    shear_kt: number;
    max_shear_kt: number;
    range_km: number;
    azimuth_deg: number;
    elevation_deg: number;
    volume_time_utc: string | null;
    first_seen_at: string | null;
    volume_count: number;
    lat: number;
    lon: number;
  } | null>(null);

  // F7: SPC convective outlooks. One stored row per Day 1/2/3; client picks
  // which day to render. Off by default so the radar stays uncluttered
  // unless the operator is actively previewing risk.
  const spcDays = spcSwr.data?.days ?? [];
  const [showSpc, setShowSpc] = useState(urlInitial.showSpc ?? false);
  const [spcDay, setSpcDay] = useState<1 | 2 | 3>(1);
  const [selectedWarning, setSelectedWarning] = useState<NwsWarning | null>(null);
  const [hoverPixel, setHoverPixel] = useState<{ lng: number; lat: number; sample: number | null } | null>(null);
  const [hoverSub, setHoverSub] = useState<any | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [audienceBreakdown, setAudienceBreakdown] = useState<AudienceBreakdown>({ total: 0, tn: 0, ms: 0, ar: 0, other: 0 });

  const [showSubs, setShowSubs] = useState(urlInitial.showSubs ?? true);
  const subsCount = subsGeo.features?.length ?? 0;

  const [inspectorCollapsed, setInspectorCollapsed] = useState(urlInitial.inspectorCollapsed ?? false);
  const [uiHidden, setUiHidden] = useState(urlInitial.uiHidden ?? false);
  const [showSitePills, setShowSitePills] = useState(urlInitial.showSitePills ?? true);
  const [showLightning, setShowLightning] = useState(urlInitial.showLightning ?? false);
  // F9: NEXRAD velocity-couplet rotation IDs. Default off — these are noisy
  // outside an active severe-weather event and the cron pipeline only fills
  // the table when the renderer has fresh Level II to scan.
  const [showCouplets, setShowCouplets] = useState(urlInitial.showCouplets ?? false);
  const coupletsSwr = useCouplets(showCouplets);
  const coupletGeo = (coupletsSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  const coupletTracks = (coupletsSwr.data?.tracks ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;

  // F10: MRMS MESH (Max Estimated Size of Hail) overlay. Translucent raster
  // layered on top of whatever the operator's looking at — keeps the
  // reflectivity context while showing where hail has actually fallen in
  // the last 30/60/120 min. 30 min is the operational default.
  const [showMesh, setShowMesh] = useState(urlInitial.showMesh ?? false);
  const [meshWindow, setMeshWindow] = useState<30 | 60 | 120>(urlInitial.meshWindow ?? 30);
  const meshSwr = useMrmsMesh(showMesh, meshWindow);
  const meshUrlPath = meshSwr.data?.urlPath ?? null;

  // F12: METAR surface obs. Compact "station plot lite" — temp-colored pin,
  // wind arrow (rotated to direction wind is going TOWARD), and a text
  // label at higher zoom levels. Clicking a station opens a popup with
  // the raw METAR.
  const [showMetar, setShowMetar] = useState(urlInitial.showMetar ?? false);
  const metarSwr = useMetar(showMetar);
  const metarGeo = (metarSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;

  // F13: mPING crowdsource reports. Pinned with a diamond glyph (vs the
  // circular LSR pin) so the operator can tell at a glance that this is
  // citizen-submitted, lower-confidence ground truth.
  const [showMping, setShowMping] = useState(urlInitial.showMping ?? false);
  const mpingSwr = useMping(showMping);
  const mpingGeo = (mpingSwr.data?.geojson ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;
  type InspectorSectionKey = 'source' | 'overlays' | 'alerts' | 'forecasts';
  const [inspectorSections, setInspectorSections] = useState<Record<InspectorSectionKey, boolean>>({
    source: true,
    overlays: true,
    alerts: true,
    forecasts: false,
  });
  const toggleInspectorSection = useCallback((key: InspectorSectionKey) => {
    setInspectorSections((s) => ({ ...s, [key]: !s[key] }));
  }, []);

  // Split view (Phase 4 v1). When non-null, the map area splits horizontally
  // and renders a second NCEP raster source for the chosen product on the
  // right side, with the camera synced imperatively. v1 only renders radar
  // tiles on the right pane — warnings/tracks/LSRs/subs stay on the left so
  // the operator has a single "data" pane and a "compare" pane.
  const [splitProduct, setSplitProduct] = useState<ProductKey | null>(null);
  const altMapRef = useRef<MapRef>(null);

  // Forecast model overlay. When set, renders an additional raster source on
  // top of radar tiles (below admin/labels) with its own opacity + forecast
  // hour. Independent of the radar product so the operator can keep observed
  // reflectivity below and a model REFC forecast on top.
  const [modelOverlay, setModelOverlay] = useState<ModelOverlayKey | null>(null);
  const activeModel = modelOverlay ? MODEL_OVERLAYS[modelOverlay] : null;
  const [modelHour, setModelHour] = useState<number>(activeModel?.hours.default ?? 1);
  const [modelOpacity, setModelOpacity] = useState<number>(70);
  // When the active overlay changes, snap the hour back into its valid range.
  useEffect(() => {
    if (!activeModel) return;
    setModelHour((h) => {
      const { min, max, step } = activeModel.hours;
      const clamped = Math.max(min, Math.min(max, h));
      return Math.round(clamped / step) * step;
    });
  }, [activeModel]);


  // Round-trip radar state through ?s=KNQA&p=velocity&hr=1… so /radar URLs are
  // shareable and survive refresh.
  useRadarUrlSync({
    site: selectedSite,
    product,
    hiRes,
    opacity,
    showNws,
    showSpc,
    showLsr,
    showZones,
    showSubs,
    showStormTracks,
    showArrows,
    colorScheme,
    satSource,
    showCap,
    inspectorCollapsed,
    uiHidden,
    showSitePills,
    showLightning,
    showCouplets,
    showMesh,
    meshWindow,
    showMetar,
    showMping,
  });

  const mapCursor = drawMode !== 'none' ? 'crosshair' : 'grab';

  const [viewState, setViewState] = useState({
    longitude: -89.8,
    latitude: 35.0,
    zoom: 7,
  });
  // Settled viewport — only changes on `moveend`. Memos that do expensive
  // work (nearestSites sort, distance ranking) depend on this, NOT on the
  // live `viewState`, so they don't recompute 60×/sec during pan.
  const [settledView, setSettledView] = useState({ longitude: -89.8, latitude: 35.0, zoom: 7 });

  // Single-site picker state. siteQuery drives the search box; pickerSites is
  // derived (search matches when there's a query, otherwise the N closest
  // NEXRAD sites to the picker center — cursor when hovering, settled
  // viewport otherwise).
  const [siteQuery, setSiteQuery] = useState('');
  const [pickerCenter, setPickerCenter] = useState<[number, number] | null>(null);
  const pickerSites = useMemo<RadarSite[]>(() => {
    if (siteQuery.trim()) return searchSites(siteQuery, 48);
    const center = pickerCenter ?? [settledView.longitude, settledView.latitude];
    return nearestSites(center, 12);
  }, [siteQuery, settledView.longitude, settledView.latitude, pickerCenter]);

  // Debounce hoverPixel into pickerCenter so the Nearest list follows the
  // cursor — but only when the cursor has settled for 250ms (the raw stream
  // fires every frame during mouse motion).
  useEffect(() => {
    if (!hoverPixel) return;
    const lng = hoverPixel.lng;
    const lat = hoverPixel.lat;
    const t = setTimeout(() => setPickerCenter([lng, lat]), 250);
    return () => clearTimeout(t);
  }, [hoverPixel?.lng, hoverPixel?.lat]);

  // Last few NEXRAD sites the operator picked, persisted in localStorage so
  // the rotation across favorites is one click after a refresh.
  const [recentSiteCodes, setRecentSiteCodes] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem('radar:recent-sites');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter((x): x is string => typeof x === 'string' && /^[A-Z]{4}$/.test(x)).slice(0, 5);
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (!selectedSite) return;
    setRecentSiteCodes((prev) => {
      const next = [selectedSite, ...prev.filter((c) => c !== selectedSite)].slice(0, 5);
      try {
        window.localStorage.setItem('radar:recent-sites', JSON.stringify(next));
      } catch {
        // localStorage can throw in private mode — recent list is best-effort.
      }
      return next;
    });
  }, [selectedSite]);

  const mapRef = useRef<MapRef>(null);
  const token = mapboxAccessToken();
  const styleUrl = mapboxStyleUrl();
  const [radarBeforeId, setRadarBeforeId] = useState<string | null>(null);

  // Presentation/annotation overlay — pen, arrow, polygon, circle, text.
  // Disabled while another draw tool (audience polygon, snap, pick-site)
  // is active so the two systems don't fight for the same mouse events.
  const annotations = useRadarAnnotations(mapRef, drawMode !== 'none');

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
  //
  // Then re-paint the road / boundary / label layers so they stay legible on
  // top of bright reflectivity. dark-v11's defaults are intentionally subtle
  // for a black basemap and disappear over yellow/red radar pixels.
  const resolvedBeforeIdRef = useRef<string | null>(null);
  // Per-layer-id cache of which Mapbox layers have already had their boost ops
  // applied. Re-running the boost is idempotent — a Set lets us safely re-fire
  // on `styledata` events without paying for setPaintProperty hundreds of times.
  const boostedLayersRef = useRef<Set<string>>(new Set());
  // Set true when the loaded style uses Mapbox's v3 Standard "imports"
  // architecture (e.g. a fork of mapbox/standard). Standard styles bury their
  // layers behind a slot system; `beforeId` and our dark-v11-shaped label
  // boost don't apply. We instead anchor our tiles + overlays via `slot`.
  const [isStandardStyle, setIsStandardStyle] = useState(false);
  // Computed once-per-style-shape: where radar tiles go (under roads + labels)
  // vs where overlays go (above labels). Each is spread onto its <Layer />.
  //   - Flat (dark-v11): tiles get `beforeId`, overlays get nothing (appended on top).
  //   - Standard imports: tiles get `slot: 'bottom'` (above water/land, below
  //     roads + labels); overlays get `slot: 'top'` (above everything).
  //     `middle` puts tiles above roads — wrong for a radar underlay.
  const tileAnchor = useMemo<Record<string, unknown>>(() => {
    if (isStandardStyle) return { slot: 'bottom' };
    return radarBeforeId ? { beforeId: radarBeforeId } : {};
  }, [isStandardStyle, radarBeforeId]);
  const overlayAnchor = useMemo<Record<string, unknown>>(() => {
    if (isStandardStyle) return { slot: 'top' };
    return {};
  }, [isStandardStyle]);
  const viewportSyncedRef = useRef(false);
  // Flips true once Mapbox fires `load`. Effects that imperatively call
  // setPaintProperty depend on it so they re-run after react-map-gl is
  // actually able to register sources/layers (before this point, getLayer
  // returns undefined even though the JSX mounted them).
  const [mapReady, setMapReady] = useState(false);

  type Bounds = { west: number; east: number; south: number; north: number };
  const [mapBounds, setMapBounds] = useState<Bounds | null>(null);
  // `mapPos.k` is just a tick counter — incrementing it on every map `move`
  // event forces a re-render so site-pill `screenPoint(...)` positions follow
  // the map smoothly during pan. Width/height stay for future use but aren't
  // read today.
  const [mapPos, setMapPos] = useState({ w: 0, h: 0, k: 0 });

  // Light, fires at 60 Hz during pan. Only bumps the tick counter so the pill
  // layer can re-project its DOM positions. No bounds query, no sorts.
  const kickMapPos = useCallback(() => {
    setMapPos((p) => ({ w: p.w, h: p.h, k: p.k + 1 }));
  }, []);

  // Heavy, fires once when the user lets go of the map. Updates bounds and the
  // settled viewport, which together trigger the picker/pill list recomputes.
  const settleMapViewport = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    if (b) {
      setMapBounds({
        west: b.getWest(),
        east: b.getEast(),
        south: b.getSouth(),
        north: b.getNorth(),
      });
    }
    const c = map.getCenter();
    setSettledView({ longitude: c.lng, latitude: c.lat, zoom: map.getZoom() });
    setMapPos((p) => ({
      w: map.getContainer().clientWidth,
      h: map.getContainer().clientHeight,
      k: p.k + 1,
    }));
  }, []);

  void mapPos;

  // GLM bbox is rounded to ~1 km so tiny pan jitters don't churn the SWR key.
  // Hook is gated by showLightning so we don't poll the renderer when the
  // overlay is off (default).
  const lightningBbox = useMemo<readonly [number, number, number, number] | null>(() => {
    if (!mapBounds) return null;
    const r = (n: number) => Math.round(n * 100) / 100;
    return [r(mapBounds.west), r(mapBounds.south), r(mapBounds.east), r(mapBounds.north)] as const;
  }, [mapBounds]);
  const lightningSwr = useLightning(showLightning, lightningBbox);
  const lightningGeo = (lightningSwr.data ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection;

  const boostBasemapLegibility = useCallback((map: mapboxgl.Map) => {
    const layers = map.getStyle()?.layers ?? [];

    type Op = { kind: 'paint' | 'layout'; id: string; prop: string; value: any };
    const ops: Op[] = [];
    const boosted = boostedLayersRef.current;
    const tryPaint = (id: string, prop: string, value: any) => {
      ops.push({ kind: 'paint', id, prop, value });
    };
    const tryLayout = (id: string, prop: string, value: any) => {
      ops.push({ kind: 'layout', id, prop, value });
    };

    // Dark-v11 sublayer IDs that add visual noise behind radar without giving
    // the operator any useful spatial context. Hiding them de-clutters the map
    // so warnings, tracks, and radar pixels are what the eye lands on.
    // Airports stay visible — they're common reference points during wx ops.
    const isNuisance = (id: string, type: string) => {
      if (type !== 'fill' && type !== 'fill-extrusion' && type !== 'symbol' && type !== 'line' && type !== 'hillshade') return false;
      if (/airport/i.test(id)) return false;
      return (
        /^poi-label/i.test(id) ||
        /^transit-label/i.test(id) ||
        /^building/i.test(id) ||
        /^landuse(-overlay)?/i.test(id) ||
        /^hillshade/i.test(id) ||
        /^pitch/i.test(id) ||
        /^natural-(line|point-label)/i.test(id) ||
        /^aerialway/i.test(id)
      );
    };

    for (const layer of layers as any[]) {
      const id: string = layer.id || '';
      if (boosted.has(id)) continue;
      if (isNuisance(id, layer.type)) {
        tryLayout(id, 'visibility', 'none');
        continue;
      }
      const isMajorRoad   = /(motorway|trunk|primary)/i.test(id) && layer.type === 'line';
      const isMidRoad     = /(secondary|tertiary)/i.test(id) && layer.type === 'line';
      const isMinorRoad   = /(road|street|bridge|tunnel)/i.test(id) && layer.type === 'line' && !isMajorRoad && !isMidRoad;
      const isAdmin0      = /^admin-0/i.test(id) && layer.type === 'line';   // country
      const isAdmin1      = /^admin-1/i.test(id) && layer.type === 'line';   // state
      const isAdmin2      = /^admin-2/i.test(id) && layer.type === 'line';   // county
      // Catch every place/settlement/state/country label sublayer dark-v11
      // emits. Also boost airport names and waterway/water-body labels —
      // they render with the dark-v11 defaults (slate text, thin halo) which
      // disappear over yellow/red reflectivity.
      const isPlaceLabel  = (
        /settlement|place-label|place-|state-label|country-label|airport-label|waterway-label|water-(point|line)-label/i.test(id)
      ) && layer.type === 'symbol';
      // Highway/interstate shields and route number labels (I-40, US 51, etc).
      const isShield      = /shield/i.test(id) && layer.type === 'symbol';
      // Generic road name labels ("Poplar Ave", "Sam Cooper Blvd", …).
      const isRoadLabel   = /road-label|road-intersection/i.test(id) && layer.type === 'symbol';

      if (isMajorRoad) {
        tryPaint(id, 'line-color', '#fde047');                                          // bright yellow
        tryPaint(id, 'line-opacity', 1);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 5, 1.5, 8, 2.8, 12, 5, 16, 9]);
      } else if (isMidRoad) {
        tryPaint(id, 'line-color', '#fcd34d');
        tryPaint(id, 'line-opacity', 0.95);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 5, 0.6, 8, 1.6, 12, 3.5, 16, 6]);
      } else if (isMinorRoad) {
        tryPaint(id, 'line-color', '#e2e8f0');
        tryPaint(id, 'line-opacity', 0.85);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 8, 0.4, 12, 1.2, 16, 3]);
      } else if (isAdmin0) {
        tryPaint(id, 'line-color', '#ffffff');
        tryPaint(id, 'line-opacity', 0.95);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 4, 1.4, 10, 3]);
      } else if (isAdmin1) {
        tryPaint(id, 'line-color', '#f1f5f9');
        tryPaint(id, 'line-opacity', 0.9);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 4, 1, 10, 2.4]);
        tryPaint(id, 'line-dasharray', [1, 0]);
      } else if (isAdmin2) {
        tryPaint(id, 'line-color', '#cbd5e1');
        tryPaint(id, 'line-opacity', 0.75);
        tryPaint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 1.4]);
      } else if (isPlaceLabel) {
        // Beefier text + dark halo so city/town/state names stay readable on
        // top of bright radar pixels. Wider halo + no blur because anti-aliased
        // halos visibly soften the letters at the small sizes used at z<7.
        tryPaint(id, 'text-color', '#ffffff');
        tryPaint(id, 'text-halo-color', '#0b1220');
        tryPaint(id, 'text-halo-width', 2.6);
        tryPaint(id, 'text-halo-blur', 0);
        tryLayout(id, 'text-size', ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 14, 12, 17, 16, 22]);
      } else if (isShield) {
        // Make the I-40 / US-51 / state route shields actually readable. Force
        // visible (some shield layers default to higher minzoom), scale the
        // icon up, and shrink the symbol-spacing so a shield appears more
        // frequently along long stretches of highway.
        tryLayout(id, 'visibility', 'visible');
        tryLayout(id, 'icon-size', ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 1.1, 12, 1.4, 16, 1.7]);
        tryLayout(id, 'text-size', ['interpolate', ['linear'], ['zoom'], 5, 10, 8, 12, 12, 14, 16, 17]);
        tryLayout(id, 'symbol-spacing', 200);
        tryLayout(id, 'icon-allow-overlap', true);
        tryLayout(id, 'text-allow-overlap', false);
        tryPaint(id, 'icon-opacity', 1);
        tryPaint(id, 'text-color', '#ffffff');
        tryPaint(id, 'text-halo-color', '#0b1220');
        tryPaint(id, 'text-halo-width', 1.4);
      } else if (isRoadLabel) {
        // Street/road names. Brighten, halo, and uncap so names show at
        // moderate zooms on top of the radar wash.
        tryLayout(id, 'visibility', 'visible');
        tryLayout(id, 'text-size', ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 13, 18, 16]);
        tryPaint(id, 'text-color', '#fef3c7');
        tryPaint(id, 'text-halo-color', '#0b1220');
        tryPaint(id, 'text-halo-width', 1.6);
      }
    }

    if (ops.length === 0) return;
    // Batch all paint/layout writes into one frame so Mapbox only fires
    // `styledata` once instead of ~50× during initial style hydration.
    requestAnimationFrame(() => {
      for (const op of ops) {
        try {
          if (op.kind === 'paint') (map.setPaintProperty as any)(op.id, op.prop, op.value);
          else (map.setLayoutProperty as any)(op.id, op.prop, op.value);
          boosted.add(op.id);
        } catch { /* layer may not exist in this style version */ }
      }
    });
  }, []);

  const handleMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    // Detect Standard-imports styles. When detected, we anchor via Mapbox
    // slots ('middle' for radar, 'top' for overlays) instead of `beforeId`,
    // and skip the dark-v11-shaped label boost (Standard's layer IDs are
    // namespaced inside the import and our patches wouldn't match anyway).
    const styleObj = (map.getStyle?.() ?? null) as { imports?: unknown[] } | null;
    const standard = Array.isArray(styleObj?.imports) && (styleObj!.imports!.length > 0);
    if (standard) setIsStandardStyle(true);
    if (!resolvedBeforeIdRef.current && !standard) {
      const layers = map.getStyle()?.layers ?? [];
      // Anchor radar so it draws UNDER roads + admin boundaries + labels but
      // OVER water/landuse. Mapbox styles vary across forks, so try in order
      // of specificity:
      //   1. First road/tunnel/bridge layer (radar goes underneath roads).
      //   2. First admin boundary (next-best: still under labels).
      //   3. First non-water line/symbol/circle (legacy fallback).
      const isRoadId = (id: string) =>
        /^(road|tunnel|bridge|motorway|street|highway)(-|_|$)/i.test(id);
      const isAdminId = (id: string) => /^admin(-|_|$)/i.test(id);
      const isExcluded = (id: string) =>
        /water|waterway|hillshade|land-structure|landuse|natural|landcover|hill|park|wetland/i.test(id);

      const roadAnchor = layers.find((l: any) => isRoadId(l.id));
      const adminAnchor = !roadAnchor
        ? layers.find((l: any) => isAdminId(l.id))
        : null;
      const fallback = !roadAnchor && !adminAnchor
        ? layers.find((l: any) => {
            if (l.type !== 'line' && l.type !== 'symbol' && l.type !== 'circle') return false;
            return !isExcluded(l.id);
          })
        : null;
      const anchor = roadAnchor ?? adminAnchor ?? fallback;
      if (anchor) {
        resolvedBeforeIdRef.current = anchor.id;
        setRadarBeforeId(anchor.id);
      }
    }
    if (!viewportSyncedRef.current) {
      viewportSyncedRef.current = true;
      settleMapViewport();
      map.on('move', kickMapPos);
      map.on('moveend', settleMapViewport);
      map.on('resize', settleMapViewport);
      setMapReady(true);
    }
    // Boost only applies to flat dark-v11-shaped styles. For Standard, the
    // imported layers' IDs are out of reach via this path, so skip entirely.
    if (!standard) {
      map.once('idle', () => boostBasemapLegibility(map));
      map.on('styledata', () => boostBasemapLegibility(map));
    }
  }, [boostBasemapLegibility, kickMapPos, settleMapViewport]);

  useEffect(() => {
    const id = setInterval(() => setTileCacheKey(Math.floor(Date.now() / 300_000)), 300_000);
    return () => clearInterval(id);
  }, []);

  // Pull the LibreWxR index every 2 min so new past frames appear in the
  // timeline as they're published.
  const lwxrIndexLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(LIBREWXR_INDEX_URL, { cache: 'no-store' });
        const j = (await r.json()) as LibreWxRIndex;
        if (cancelled) return;
        if (j?.host && j?.radar) {
          // On the first successful fetch, pin `frame` to the latest past
          // frame in the SAME batched update as setLwxrIndex. Otherwise the
          // first render mounts a lazy window around frame=0 (oldest), the
          // pin effect then bumps frame to lwxrPastCount-1, and the window
          // has to remount — racing tile loads and producing a blank map
          // until the user advances the timeline.
          if (!lwxrIndexLoadedRef.current) {
            lwxrIndexLoadedRef.current = true;
            const pastLen = j.radar.past?.length ?? 0;
            if (pastLen > 0) setFrame(pastLen - 1);
          }
          setLwxrIndex(j);
        }
      } catch {/* ignore */}
    };
    load();
    const id = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Realtime channel — any insert/update on nws_alerts triggers an immediate
  // SWR revalidation. SWR dedupes against in-flight requests so a burst of
  // postgres changes only kicks off one re-fetch.
  useEffect(() => {
    const supa = supabaseBrowser();
    const channel = supa
      .channel('radar-nws')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'nws_alerts' },
        () => { swrMutate(WARNINGS_KEY); },
      )
      .subscribe();
    return () => {
      supa.removeChannel(channel);
    };
  }, [swrMutate]);

  const effectiveProduct: ProductKey = useMemo(() => {
    const meta = PRODUCTS[product];
    if (selectedSite && !meta.modes.site) return 'reflectivity';
    if (!selectedSite && !meta.modes.composite) return 'composite';
    return product;
  }, [product, selectedSite]);

  // Mirror the main map's camera onto the right (split) pane. jumpTo doesn't
  // fire Mapbox `move` events, so there's no feedback loop. Right pane has
  // interactions disabled in its <Map> props so the operator can only drive
  // the camera from the left pane.
  useEffect(() => {
    if (!splitProduct) return;
    const m = altMapRef.current?.getMap();
    if (!m) return;
    m.jumpTo({
      center: [viewState.longitude, viewState.latitude],
      zoom: viewState.zoom,
    });
  }, [splitProduct, viewState.longitude, viewState.latitude, viewState.zoom]);

  // Auto-clear split when its preconditions break:
  //   - no site selected (CONUS / LibreWxR mode), or
  //   - main product isn't reflectivity/velocity, or
  //   - main product == split product (would render the same thing twice).
  useEffect(() => {
    if (!splitProduct) return;
    if (!selectedSite) { setSplitProduct(null); return; }
    if (effectiveProduct !== 'reflectivity' && effectiveProduct !== 'velocity') {
      setSplitProduct(null);
      return;
    }
    if (splitProduct === effectiveProduct) {
      setSplitProduct(effectiveProduct === 'reflectivity' ? 'velocity' : 'reflectivity');
    }
  }, [splitProduct, selectedSite, effectiveProduct]);

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
      // Default to whichever NEXRAD site is closest to the current map
      // center so single-site products don't yank the operator across the
      // country when they tap CC / BVEL from a non-Mid-South view.
      const center: [number, number] = [viewState.longitude, viewState.latitude];
      const nearest = nearestSites(center, 1)[0] ?? NEXRAD_SITES_BY_CODE[DEFAULT_SITE_CODE];
      setSelectedSite(nearest.code);
      mapRef.current?.flyTo({ center: nearest.center, zoom: nearest.zoom, duration: 700 });
    }
    setProduct(k);
  }, [selectedSite, viewState.longitude, viewState.latitude]);

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
  // LibreWxR drives the timeline for two CONUS-only products: 'composite' (its
  // native radar dataset, 2h past + ~1h nowcast at 10 min intervals) and
  // 'satellite' (12h hourly IR cloud-cover, no forecast). Every other product
  // is a single live frame — we don't fabricate forecasts.
  const lwxrSubject: 'radar' | 'satellite' | null =
    selectedSite ? null
      : effectiveProduct === 'composite' ? 'radar'
      : effectiveProduct === 'satellite' && satSource === 'lwxr' ? 'satellite'
      : null;
  const useLibreWxR = lwxrSubject !== null;
  const lwxrAllFrames = useMemo<LibreWxRFrame[]>(() => {
    if (!useLibreWxR || !lwxrIndex) return [];
    if (lwxrSubject === 'satellite') return [...(lwxrIndex.satellite?.infrared ?? [])];
    return [...(lwxrIndex.radar?.past ?? []), ...(lwxrIndex.radar?.nowcast ?? [])];
  }, [useLibreWxR, lwxrSubject, lwxrIndex]);
  // For satellite there is no nowcast — every frame is "past", so the live
  // cursor sits at the final frame.
  const lwxrPastCount = useMemo(() => {
    if (!useLibreWxR || !lwxrIndex) return 0;
    if (lwxrSubject === 'satellite') return lwxrIndex.satellite?.infrared?.length ?? 0;
    return lwxrIndex.radar?.past?.length ?? 0;
  }, [useLibreWxR, lwxrSubject, lwxrIndex]);
  const totalFrames = useLibreWxR ? Math.max(1, lwxrAllFrames.length) : 1;

  // Window mounted LibreWxR raster sources to ±LWXR_MOUNT_RADIUS around the
  // current frame so we never have more than ~7 sources alive at once instead
  // of 30+. The previous frame (for crossfade) and a small look-ahead buffer
  // (for scrubbing/playback) are always inside the window. Mapbox keeps the
  // tile cache for unmounted sources, so re-entering the window is cheap.
  // Mount just the current frame on first paint so the initial tile burst is
  // ~1 frame instead of 7 — switching to CREF used to fetch ~100 tiles at once
  // (browser limits ~6 parallel per origin → multiple round-trip batches).
  // After the map idles (or the operator hits play), expand back to ±3 for
  // smooth scrubbing/playback.
  const LWXR_MOUNT_RADIUS_INITIAL = 0;
  const LWXR_MOUNT_RADIUS_FULL = 3;
  const [lwxrMountRadius, setLwxrMountRadius] = useState(LWXR_MOUNT_RADIUS_INITIAL);
  useEffect(() => {
    setLwxrMountRadius(LWXR_MOUNT_RADIUS_INITIAL);
  }, [lwxrSubject]);
  useEffect(() => {
    if (!useLibreWxR) return;
    if (lwxrMountRadius === LWXR_MOUNT_RADIUS_FULL) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const expand = () => setLwxrMountRadius(LWXR_MOUNT_RADIUS_FULL);
    if (map.loaded() && !map.isMoving() && !map.isZooming()) {
      const t = setTimeout(expand, 50);
      return () => clearTimeout(t);
    }
    map.once('idle', expand);
    return () => { map.off('idle', expand); };
  }, [useLibreWxR, lwxrSubject, lwxrMountRadius, mapReady]);
  useEffect(() => {
    if (playing && lwxrMountRadius < LWXR_MOUNT_RADIUS_FULL) {
      setLwxrMountRadius(LWXR_MOUNT_RADIUS_FULL);
    }
  }, [playing, lwxrMountRadius]);

  const lwxrMountedFrames = useMemo<LibreWxRFrame[]>(() => {
    if (!useLibreWxR || lwxrAllFrames.length === 0) return [];
    const start = Math.max(0, frame - lwxrMountRadius);
    const end = Math.min(lwxrAllFrames.length - 1, frame + lwxrMountRadius);
    return lwxrAllFrames.slice(start, end + 1);
  }, [useLibreWxR, lwxrAllFrames, frame, lwxrMountRadius]);

  // Track whether tiles for the current product are still loading so the
  // product chip can show a "fetching" pip. We arm a one-shot map.once('idle')
  // when the product/site changes and clear loading when Mapbox reports idle
  // (i.e. all pending tile fetches finished). 10s failsafe in case the map
  // never goes idle (e.g., tile errors).
  const [tilesLoading, setTilesLoading] = useState(false);
  const tileLoadEpochRef = useRef(0);
  useEffect(() => {
    if (!mapReady) return;
    const epoch = ++tileLoadEpochRef.current;
    setTilesLoading(true);
    const map = mapRef.current?.getMap();
    if (!map) return;
    const onIdle = () => {
      if (tileLoadEpochRef.current === epoch) setTilesLoading(false);
    };
    map.once('idle', onIdle);
    const failsafe = setTimeout(() => {
      if (tileLoadEpochRef.current === epoch) setTilesLoading(false);
    }, 10000);
    return () => {
      clearTimeout(failsafe);
      map.off('idle', onIdle);
    };
  }, [effectiveProduct, selectedSite, satSource, mapReady]);

  // Pin frame to the latest past frame whenever the frame list changes (e.g.
  // a new past frame just arrived, or the user switched away from LibreWxR).
  const prevTotal = useRef(0);
  useEffect(() => {
    if (!useLibreWxR) {
      setFrame(0);
      setPlaying(false);
      return;
    }
    if (lwxrPastCount && prevTotal.current !== totalFrames) {
      setFrame(Math.max(0, lwxrPastCount - 1));
      prevTotal.current = totalFrames;
    }
  }, [useLibreWxR, lwxrPastCount, totalFrames]);

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
    setLevel2Attempt(0);

    const RETRY_DELAYS = [4000, 8000, 12000];
    const format = pngFallback ? 'png' : 'geojson';
    // Track every pending retry timeout so a fast site/product switch cancels
    // them instead of letting them fire and queue stale fetches at the
    // renderer.
    const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
    const abort = new AbortController();

    // localStorage-cached pointer to the last successful render for this
    // (site, product, sweep, composite, format) combo. The cached entry has
    // the overlay metadata (bounds, vmin/vmax, sweeps, etc.) plus the
    // geojson_url / image_url — content-addressed by scan_time so the URL
    // always serves the exact bytes we rendered last time. Fetching it pulls
    // straight from the browser's HTTP cache (immutable, never expires) so
    // revisits paint in <1s while the fresh /api/radar/level2 call runs in
    // parallel and replaces the data once the latest scan finishes rendering.
    const cacheKey = `radar:l2:${selectedSite}:${level2Product}:${resolvedSweepIndex}:${isComposite ? 1 : 0}:${format}`;
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(cacheKey) : null;
      if (raw) {
        const cached = JSON.parse(raw) as { overlay?: Level2Overlay };
        const ov = cached.overlay;
        if (ov && (ov.image_url || ov.geojson_url)) {
          setLevel2Overlay(ov);
          if (format === 'geojson' && ov.geojson_url) {
            (async () => {
              try {
                const r = await fetch(ov.geojson_url!, { cache: 'force-cache', signal: abort.signal });
                if (cancelled || !r.ok || !r.body) return;
                const decompressed = r.body.pipeThrough(new DecompressionStream('gzip'));
                const text = await new Response(decompressed).text();
                const gj = JSON.parse(text);
                if (cancelled) return;
                // Only apply the cached GeoJSON if a fresh fetch hasn't beat
                // us to it — preserves the latest scan when both finish.
                setLevel2GeoJSON((prev: any) => prev ?? gj);
              } catch {
                /* cache miss / parse failure / aborted — fall through to live fetch */
              }
            })();
          }
        }
      }
    } catch {
      /* localStorage unavailable (private mode etc) — skip silently */
    }

    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        pendingTimeouts.delete(t);
        if (!cancelled) fn();
      }, ms);
      pendingTimeouts.add(t);
    };

    const load = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      setLevel2Loading(true);

      try {
        const url = `/api/radar/level2/${selectedSite}`
          + `?product=${level2Product}`
          + `&format=${format}`
          + `&sweep_index=${resolvedSweepIndex}`
          + (isComposite ? '&composite=1' : '');
        const res = await fetch(url, { cache: 'no-store', signal: abort.signal });
        const data = await res.json();
        if (cancelled) return;

        if (data.error) {
          if (attempt < RETRY_DELAYS.length) {
            setLevel2Error('renderer_waking');
            setLevel2Attempt(attempt + 1);
            schedule(() => load(attempt + 1), RETRY_DELAYS[attempt]);
            return;
          }
          setLevel2Error(data.error);
          setLevel2Overlay(null);
          setLevel2GeoJSON(null);
          return;
        }

        setLevel2Overlay(data as Level2Overlay);
        setLevel2Error(null);
        try {
          // Persist the pointer (metadata + URL) so next visit can re-render
          // instantly from the browser HTTP cache. Bytes themselves stay in
          // the HTTP cache — only the small JSON metadata lives in localStorage.
          window.localStorage.setItem(cacheKey, JSON.stringify({ overlay: data, savedAt: Date.now() }));
        } catch {
          /* over quota / private mode — best-effort */
        }

        if (format === 'png') {
          // PNG path: nothing else to download — the renderer URL is a public
          // PNG, Mapbox image source handles the rest.
          setLevel2GeoJSON(null);
          return;
        }

        if (!data.geojson_url) throw new Error('renderer returned no geojson_url');
        const gjRes = await fetch(data.geojson_url, { cache: 'default', signal: abort.signal });
        if (!gjRes.ok) throw new Error(`geojson fetch ${gjRes.status}`);
        if (!gjRes.body) throw new Error('geojson response has no body');
        const decompressed = gjRes.body.pipeThrough(new DecompressionStream('gzip'));
        const text = await new Response(decompressed).text();
        const gj = JSON.parse(text);
        if (cancelled) return;
        setLevel2GeoJSON(gj);
      } catch (err: any) {
        if (cancelled || err?.name === 'AbortError') return;
        if (attempt < RETRY_DELAYS.length) {
          setLevel2Error('renderer_waking');
          schedule(() => load(attempt + 1), RETRY_DELAYS[attempt]);
          return;
        }
        setLevel2Error('renderer_unreachable');
        setLevel2GeoJSON(null);
      } finally {
        if (!cancelled) setLevel2Loading(false);
      }
    };

    // Debounce the initial fetch by 150 ms so rapid product/sweep/site clicks
    // collapse into a single request. The loading indicator is set on the
    // leading edge so the UI still feels responsive while the timer is armed.
    setLevel2Loading(true);
    const debounceT = setTimeout(() => { void load(); }, 150);
    const id = setInterval(() => load(0), 300_000);
    return () => {
      cancelled = true;
      clearTimeout(debounceT);
      clearInterval(id);
      pendingTimeouts.forEach(clearTimeout);
      pendingTimeouts.clear();
      abort.abort();
    };
  }, [useLevel2, selectedSite, level2Product, resolvedSweepIndex, isComposite, pngFallback]);

  const radarSourceId = 'radar-source';
  const radarLayerId = 'radar-layer';
  const level2GeoJSONSourceId = 'level2-geojson';
  const level2ImageSourceId = 'level2-image';

  // Non-LibreWxR products render a single "now" tile URL (NCEP / THREDDS).
  const liveTileUrl: string | null = useMemo(() => {
    if (useLibreWxR) return null;
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
      case 'satellite': {
        // satSource === 'lwxr' is handled by the LibreWxR animated pipeline
        // above (useLibreWxR returns null here). Anything else is a single
        // live frame from GIBS or IEM — dispatched by provider in satTileUrl.
        if (satSource === 'lwxr') return null;
        const cfg = GOES_SOURCES[satSource as GoesSourceId];
        if (!cfg) return null;
        return satTileUrl(cfg, tileCacheKey);
      }
      default:
        return null;
    }
  }, [effectiveProduct, selectedSite, tileCacheKey, mrmsUrlPath, useLibreWxR, satSource]);

  const lwxrFrameUrl = useCallback((f: LibreWxRFrame) => {
    if (!lwxrIndex) return '';
    // Satellite tiles use a fixed `/0/0_0.png` tail (color/options don't apply
    // to IFS cloud cover) and ignore the arrows overlay.
    if (lwxrSubject === 'satellite') {
      return `${lwxrIndex.host}${f.path}/${LIBREWXR_TILE_SIZE}/{z}/{x}/{y}/0/0_0.png`;
    }
    const arrowsQ = showArrows ? '?arrows=dark' : '';
    return `${lwxrIndex.host}${f.path}/${LIBREWXR_TILE_SIZE}/{z}/{x}/{y}/${colorScheme}/${LIBREWXR_OPTS}.png${arrowsQ}`;
  }, [lwxrIndex, lwxrSubject, showArrows, colorScheme]);

  // Stable key for the live source — only swap when the URL *pattern* changes
  // (provider / site / product / MRMS dataset), not on every frame.
  const liveSourceKey = useMemo(() => {
    const base = selectedSite ? `site:${selectedSite.toLowerCase()}` : 'conus';
    const satTag = effectiveProduct === 'satellite' ? `:${satSource}` : '';
    return `${base}:${effectiveProduct}${satTag}:${mrmsUrlPath ?? '-'}:${tileCacheKey}`;
  }, [selectedSite, effectiveProduct, tileCacheKey, mrmsUrlPath, satSource]);

  const liveRadarSource = useMemo(() => {
    if (!liveTileUrl) return null;
    const base = { type: 'raster' as const, tiles: [liveTileUrl], tileSize: 256 };
    if (effectiveProduct === 'satellite' && satSource !== 'lwxr') {
      const cfg = GOES_SOURCES[satSource as GoesSourceId];
      if (cfg) return { ...base, maxzoom: cfg.maxzoom };
    }
    return base;
  }, [liveTileUrl, effectiveProduct, satSource]);

  // Right-pane (split view) tile URL. Mirrors liveTileUrl's logic but always
  // for `splitProduct`, and only when splitProduct is set AND we have a site
  // (CONUS LibreWxR doesn't fit the split-view UX — it'd just be the same
  // mosaic twice).
  const altTileUrl: string | null = useMemo(() => {
    if (!splitProduct || !selectedSite) return null;
    const site = selectedSite.toLowerCase();
    switch (splitProduct) {
      case 'reflectivity':
        return NCEP_WMS_URL(site, `${site}:${site}_sr_bref`, tileCacheKey);
      case 'velocity':
        return NCEP_WMS_URL(site, `${site}:${site}_sr_bvel`, tileCacheKey);
      default:
        return null;
    }
  }, [splitProduct, selectedSite, tileCacheKey]);

  const altLiveRadarSource = useMemo(() => {
    if (!altTileUrl) return null;
    return { type: 'raster' as const, tiles: [altTileUrl], tileSize: 256 };
  }, [altTileUrl]);

  const altSourceKey = useMemo(() => {
    if (!splitProduct || !selectedSite) return 'alt:none';
    return `alt:${selectedSite.toLowerCase()}:${splitProduct}:${tileCacheKey}`;
  }, [splitProduct, selectedSite, tileCacheKey]);

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

  // Live + Level II opacity are kept up-to-date imperatively (see the
  // useEffect just below this block), so these layer configs intentionally
  // bake in the *current* opacity at mount but don't get re-created on every
  // opacity slider tick — that would force react-map-gl to diff the whole
  // paint object 60×/sec while dragging the slider.
  const liveRadarLayer = useMemo(() => ({
    id: radarLayerId,
    type: 'raster' as const,
    source: radarSourceId,
    paint: {
      'raster-opacity': opacity / 100,
      // Short fade smooths the 5-min NCEP refresh swap without making
      // pan/zoom feel sluggish.
      'raster-fade-duration': 200,
      // `linear` resampling blends pixels at high zoom so reflectivity reads
      // as a smooth gradient instead of pixelated steps. Matches RadarScope /
      // Weatherwise's rendering. NCEP/THREDDS tiles already encode discrete
      // dBZ bands, so the blend gives RadarScope-style edge softening without
      // losing the underlying step palette.
      'raster-resampling': 'linear' as const,
      // Punch up the basemap-tile blend — saturation makes the dBZ colors
      // pop against the colorful dusk basemap; contrast lifts the midtones
      // so light/moderate returns don't read muddy.
      'raster-saturation': 0.35,
      'raster-contrast': 0.2,
    },
    ...tileAnchor,
  // opacity is intentionally NOT a dep — the imperative effect below mutates
  // it via setPaintProperty so we don't re-render the layer object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [tileAnchor]);

  // Layer ID is keyed by subject so radar/satellite frames with matching
  // timestamps can't accidentally cross-talk in the imperative opacity effect.
  const lwxrLayerId = (time: number) => `lwxr-layer-${lwxrSubject ?? 'none'}-${time}`;
  // Source key includes subject + radar render params so flipping the arrows
  // toggle, swapping color scheme, or switching subject remounts the source
  // and refetches tiles. Mapbox keeps the previous tile cache around, so
  // returning to a prior config is fast.
  const lwxrSourceId = (time: number) =>
    `lwxr-src-${lwxrSubject ?? 'none'}-${lwxrSubject === 'radar' ? `${colorScheme}-${showArrows ? 'a' : 'n'}-` : ''}${time}`;

  const fillColorExpr = useMemo(() => {
    if (!level2Overlay) return '#000000';
    return buildFillColorExpr(level2Product, level2Overlay.vmin, level2Overlay.vmax);
  }, [level2Overlay, level2Product]);

  const level2FillLayer = useMemo(() => ({
    id: 'level2-fill',
    type: 'fill' as const,
    source: level2GeoJSONSourceId,
    paint: {
      'fill-color': fillColorExpr,
      'fill-opacity': level2Overlay
        ? buildFillOpacityExpr(level2Product, opacity / 100,
                               level2Overlay.vmin, level2Overlay.vmax)
        : 0,
      'fill-antialias': true,
    },
    ...tileAnchor,
  // opacity excluded for the same reason as liveRadarLayer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fillColorExpr, level2Overlay, level2Product, tileAnchor]);

  const level2RasterLayer = useMemo(() => ({
    id: 'level2-raster',
    type: 'raster' as const,
    source: level2ImageSourceId,
    paint: {
      'raster-opacity': opacity / 100,
      'raster-fade-duration': 0,
      'raster-resampling': 'linear' as const,
      'raster-saturation': 0.35,
      'raster-contrast': 0.2,
    },
    ...tileAnchor,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [tileAnchor]);

  // Live opacity + LibreWxR frame visibility, all imperatively so swapping
  // frames during playback never tears down a source (tiles stay in Mapbox
  // cache → buttery scrubbing once each frame has been seen once).
  //
  // Only the previously-visible frame and the current frame get touched per
  // tick — the old code walked all 30+ frames every frame change, which was
  // 30+ setPaintProperty calls and a noticeable hitch during playback.
  const prevLwxrFrameRef = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (map.getLayer(radarLayerId)) {
      // Hide the NCEP underlay when LibreWxR (CONUS animated) is active or
      // when Level II is actually painting polygons. "Actually painting"
      // means level2GeoJSON is set (geojson mode) OR level2Overlay.image_url
      // is set (PNG mode) — the previous check on just level2Overlay was too
      // eager: metadata arrives ~5-10 s before the gzipped geojson finishes
      // downloading, and during that gap NCEP was hidden but Level II hadn't
      // mounted, leaving a blank map. NCEP is intentionally the coarse
      // first-paint while Hi-Res is en route.
      const level2Painting =
        useLevel2 &&
        ((!pngFallback && !!level2GeoJSON) ||
          (pngFallback && !!level2Overlay?.image_url));
      const hideNcep = useLibreWxR || level2Painting;
      map.setPaintProperty(radarLayerId, 'raster-opacity', hideNcep ? 0 : opacity / 100);
    }
    if (useLibreWxR) {
      const op = opacity / 100;
      const prev = prevLwxrFrameRef.current;
      if (prev != null && prev !== frame) {
        const prevF = lwxrAllFrames[prev];
        if (prevF && map.getLayer(lwxrLayerId(prevF.time))) {
          map.setPaintProperty(lwxrLayerId(prevF.time), 'raster-opacity', 0);
        }
      }
      const curF = lwxrAllFrames[frame];
      if (curF) {
        const layerId = lwxrLayerId(curF.time);
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, 'raster-opacity', op);
        } else {
          // Layer was just JSX-mounted but Mapbox hasn't finished registering
          // it yet (can happen when the lazy mount window shifts). Apply the
          // opacity once the map next reaches idle.
          map.once('idle', () => {
            if (map.getLayer(layerId)) {
              map.setPaintProperty(layerId, 'raster-opacity', op);
            }
          });
        }
      }
      prevLwxrFrameRef.current = frame;
    } else if (prevLwxrFrameRef.current != null) {
      // Switched away from LibreWxR; clear the cursor so the next entry
      // doesn't try to hide a stale "previous" frame.
      prevLwxrFrameRef.current = null;
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
  }, [opacity, level2Overlay, level2GeoJSON, pngFallback, level2Product, useLibreWxR, useLevel2, level2Error, lwxrAllFrames, frame, mapReady]);

  // Imperative line-width update when the operator selects a warning. The
  // layer's `paint` prop stays referentially stable (no react-map-gl diff);
  // we just retarget the case expression's matched id.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.getLayer('warning-line')) return;
    const id = selectedWarning?.id;
    map.setPaintProperty(
      'warning-line',
      'line-width',
      id ? ['case', ['==', ['get', 'id'], id], 3.5, 2] : 2,
    );
  }, [selectedWarning, warningsGeo, mapReady]);

  // Hover handler — throttled to ~30 Hz. Each call does up to two
  // queryRenderedFeatures hits which are non-trivial on the level2-fill layer
  // (thousands of polygon wedges), so halving the cadence from raw mousemove
  // (~60 Hz) measurably reduces input-handler latency without making the
  // inspector readout feel choppy.
  const hoverThrottleRef = useRef(0);
  const handleMapMouseMove = useCallback((e: MapMouseEvent) => {
    // Skip hover inspection while drawing annotations — the move events
    // belong to the pen/arrow/circle drag and shouldn't trigger pill
    // popouts at the same time.
    if (annotations.isActive) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - hoverThrottleRef.current < 32) return;
    hoverThrottleRef.current = now;
    const map = mapRef.current?.getMap();
    const { lng, lat } = e.lngLat;
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
  }, [useLevel2, pngFallback, level2Overlay, showSubs]);

  // F7: derived selectors for the currently-rendered SPC day.
  const activeSpc = useMemo(
    () => spcDays.find((d) => d.day_number === spcDay) ?? null,
    [spcDays, spcDay],
  );
  const spcGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!activeSpc) return { type: 'FeatureCollection', features: [] };
    return activeSpc.geojson;
  }, [activeSpc]);
  const spcLayerVis = showSpc ? 'visible' : 'none' as const;

  const nwsLayerVis = showNws ? 'visible' : 'none' as const;
  const trackLayerVis = showNws && showStormTracks ? 'visible' : 'none' as const;
  const stormTrackCount = useMemo(() => {
    const ids = new Set<string>();
    for (const f of tracksGeo.features ?? []) {
      const aid = (f.properties as { alert_id?: string })?.alert_id;
      if (aid) ids.add(aid);
    }
    return ids.size;
  }, [tracksGeo]);

  // Subscribers
  const subsHaloLayer = useMemo<any>(() => ({
    id: 'subs-halo', type: 'circle' as const, source: 'subs-source',
    layout: { visibility: showSubs ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 7, 12, 10, 20, 14, 28],
      'circle-color': '#38bdf8', 'circle-opacity': 0.25, 'circle-blur': 0.55,
    },
    ...overlayAnchor,
  }), [showSubs, overlayAnchor]);
  const subsPinLayer = useMemo<any>(() => ({
    id: 'subs-pin', type: 'circle' as const, source: 'subs-source',
    layout: { visibility: showSubs ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 7, 5, 10, 7, 14, 9],
      'circle-color': '#38bdf8',
      'circle-stroke-color': '#0b1220',
      'circle-stroke-width': 1.5,
    },
    ...overlayAnchor,
  }), [showSubs, overlayAnchor]);

  // Selection / draw GeoJSON features — memo them so the Source's `data` prop
  // doesn't churn on every parent re-render (which would force Mapbox setData
  // calls with identical content).
  const selectionCircleData = useMemo(() => {
    if (!selection || selection.type !== 'circle') return null;
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: selection.center },
      properties: {},
    };
  }, [selection]);
  const selectionCirclePaint = useMemo<any>(() => {
    if (!selection || selection.type !== 'circle') return null;
    return {
      'circle-radius': (selection.radius_km / 111) * 1000 * (settledView.zoom / 8),
      'circle-color': 'rgba(251,191,36,0.15)',
      'circle-stroke-color': '#fbbf24',
      'circle-stroke-width': 2,
    };
  }, [selection, settledView.zoom]);
  const selectionPolyData = useMemo(() => {
    if (!selection || selection.type !== 'polygon') return null;
    return {
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [selection.coordinates] },
      properties: {},
    };
  }, [selection]);
  const polyDrawData = useMemo(() => {
    if (drawMode !== 'polygon' || polygonPoints.length === 0) return null;
    return {
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: polygonPoints },
      properties: {},
    };
  }, [drawMode, polygonPoints]);

  const handleMapClick = (e: MapMouseEvent) => {
    // Annotation tools own the mouse while active; the RadarAnnotations
    // hook attaches its own map.on('click') listener for vertex placement.
    if (annotations.isActive) return;
    if (drawMode !== 'none' && e.originalEvent) {
      e.originalEvent.stopPropagation();
      e.originalEvent.preventDefault?.();
    }
    const { lng, lat } = e.lngLat;

    if (drawMode === 'polygon') {
      const pts = [...polygonPoints, [lng, lat] as [number, number]];
      setPolygonPoints(pts);
      return;
    }

    if (drawMode === 'pick-site') {
      const nearest = nearestSites([lng, lat], 1)[0];
      if (nearest) {
        mapRef.current?.flyTo({ center: nearest.center, zoom: nearest.zoom, duration: 700 });
        setSelectedSite(nearest.code);
      }
      setDrawMode('none');
      return;
    }

    if (drawMode === 'snap') {
      const map = mapRef.current?.getMap();
      if (!map || !map.getLayer('warning-fill')) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: ['warning-fill'] });
      if (hits.length === 0) return;
      const w = warnings.find((x) => x.id === (hits[0].properties as any)?.id);
      if (!w) return;
      const coords = warningToSelectionCoords(w);
      if (!coords) return;
      const newSel: Selection = { type: 'polygon', coordinates: coords };
      setSelection(newSel);
      setDrawMode('none');
      setSelectedWarning(w);
      previewAudience(newSel);
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
    // F4: LSR pins next — same priority logic (small targets first).
    if (showLsr && map.getLayer('lsr-pin')) {
      const lsrHits = map.queryRenderedFeatures(e.point, { layers: ['lsr-pin'] });
      if (lsrHits.length > 0) {
        const props = lsrHits[0].properties as any;
        setSelectedLsr({
          id: String(props?.id ?? ''),
          event: String(props?.event ?? ''),
          hazard: (props?.hazard as string | null) ?? null,
          magnitude: (props?.magnitude as string | null) ?? null,
          location: (props?.location as string | null) ?? null,
          occurred_at: (props?.occurred_at as string | null) ?? null,
          remark: (props?.remark as string | null) ?? null,
          source: (props?.source as string | null) ?? null,
        });
        return;
      }
    }
    // F13: mPING report click. Higher priority than METAR but lower
    // than LSRs since mPING is community-sourced.
    if (showMping && map.getLayer('mping-pin')) {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['mping-pin'] });
      if (hits.length > 0) {
        const props = hits[0].properties as any;
        setSelectedMping({
          id: Number(props?.id ?? 0),
          description: String(props?.description ?? ''),
          hazard: String(props?.hazard ?? 'other'),
          obtime: String(props?.obtime ?? ''),
        });
        return;
      }
    }
    // F12: METAR station click. Lower priority than warning fills but
    // higher than nothing — the operator clicks a station to see surface
    // obs context for whatever storm they're looking at.
    if (showMetar && map.getLayer('metar-pin')) {
      const mHits = map.queryRenderedFeatures(e.point, { layers: ['metar-pin'] });
      if (mHits.length > 0) {
        const props = mHits[0].properties as any;
        setSelectedMetar({
          icaoId: String(props?.icaoId ?? ''),
          name: (props?.name as string | null) ?? null,
          obsTime: (props?.obsTime as string | null) ?? null,
          temp: props?.temp != null ? Number(props.temp) : null,
          dewp: props?.dewp != null ? Number(props.dewp) : null,
          wdir: props?.wdir != null ? Number(props.wdir) : null,
          wspd: props?.wspd != null ? Number(props.wspd) : null,
          wgst: props?.wgst != null ? Number(props.wgst) : null,
          altim: props?.altim != null ? Number(props.altim) : null,
          wxString: (props?.wxString as string | null) ?? null,
          rawOb: (props?.rawOb as string | null) ?? null,
        });
        return;
      }
    }
    // F9: rotation IDs. Sit above LSRs in click priority because a strong
    // couplet is a higher-urgency signal than a backfilled storm report.
    if (showCouplets && map.getLayer('couplet-pin')) {
      const cpHits = map.queryRenderedFeatures(e.point, { layers: ['couplet-pin'] });
      if (cpHits.length > 0) {
        const f = cpHits[0];
        const props = f.properties as any;
        const geom = f.geometry as GeoJSON.Point | undefined;
        const [lon, lat] = geom?.coordinates ?? [0, 0];
        setSelectedCouplet({
          track_id: String(props?.track_id ?? ''),
          site: String(props?.site ?? ''),
          shear_kt: Number(props?.shear_kt ?? 0),
          max_shear_kt: Number(props?.max_shear_kt ?? 0),
          range_km: Number(props?.range_km ?? 0),
          azimuth_deg: Number(props?.azimuth_deg ?? 0),
          elevation_deg: Number(props?.elevation_deg ?? 0),
          volume_time_utc: (props?.volume_time_utc as string | null) ?? null,
          first_seen_at: (props?.first_seen_at as string | null) ?? null,
          volume_count: Number(props?.volume_count ?? 1),
          lat: Number(lat),
          lon: Number(lon),
        });
        return;
      }
    }
    if (!map.getLayer('warning-fill')) return;
    const hits = map.queryRenderedFeatures(e.point, { layers: ['warning-fill'] });
    if (hits.length > 0) {
      const w = warnings.find((x) => x.id === (hits[0].properties as any)?.id);
      if (w) {
        setSelectedWarning(w);
        focusWarning(w);
      }
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
    setPolygonPoints([]);
    setSelection(null);
    setPreviewCount(null);
  };

  const startPolygonDraw = () => { cancelDraw(); setDrawMode('polygon'); setPolygonPoints([]); };
  const startSnapMode = () => { cancelDraw(); setDrawMode('snap'); };

  // Extract a single outer ring from a warning's GeoJSON geometry for use as
  // a Selection. MultiPolygon warnings (split alerts) lose their other parts —
  // a known limitation; extend Selection to support MultiPolygon if it bites.
  const warningToSelectionCoords = (w: NwsWarning): number[][] | null => {
    const g = w.geometry;
    if (!g) return null;
    if (g.type === 'Polygon') return g.coordinates[0] ?? null;
    if (g.type === 'MultiPolygon') return g.coordinates[0]?.[0] ?? null;
    return null;
  };

  // Live audience preview while drawing — once the polygon has at least 3
  // vertices we close it and call resolve_audience after a brief debounce.
  // setPreviewCount is the same state shown in the post-Complete card, which
  // is fine since `selection` is null during draw so the card isn't mounted.
  useEffect(() => {
    if (drawMode !== 'polygon' || polygonPoints.length < 3) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const ring = [...polygonPoints, polygonPoints[0]];
      const supa = supabaseBrowser();
      const spec = { geometry: { type: 'Polygon', coordinates: [ring] } };
      const { data, error } = await supa.rpc('resolve_audience', { spec });
      if (cancelled) return;
      if (!error && data) setPreviewCount(data.length);
      else setPreviewCount(null);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [drawMode, polygonPoints]);

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

  // F1+F2: build /compose URL for a warning row's "Send" action. Passes
  //   - the warning polygon as the audience geometry
  //   - the hazard kind so /compose can auto-select the matching template
  //   - the AI summary (or a fallback) as the default body, used until the
  //     operator picks a template that overrides it.
  // 'other' hazard is intentionally omitted from the template auto-match —
  // generic warnings shouldn't snap to anything.
  const composeUrlForWarning = useCallback((w: NwsWarning): string => {
    const params = new URLSearchParams();
    params.set('geo', JSON.stringify(w.geometry));
    if (w.hazard && w.hazard !== 'other') {
      params.set('hazard', w.hazard);
    }
    // Carry the source NWS id through so the compose action can link the
    // outbound message back to the alert row — that link lets /m/[id] show
    // full NWS context and reach for the alert's polygon when the operator
    // swaps the audience away from the radar selection.
    if (w.nws_id) params.set('nws_id', w.nws_id);
    const body = warningBodySeed(w);
    if (body) params.set('body', body);
    return `/compose?${params.toString()}`;
  }, []);

  // F3: same as composeUrlForWarning but the audience geometry is the
  // forecast-track corridor instead of the warning polygon. Caller must
  // verify w.forecast_track exists.
  const composeUrlForWarningTrack = useCallback((w: NwsWarning): string | null => {
    if (!w.forecast_track) return null;
    const corridor_km = w.in_path_corridor_km ?? 8;
    const spec = { type: 'track', line: w.forecast_track, corridor_km };
    const params = new URLSearchParams();
    params.set('geo', JSON.stringify(spec));
    if (w.hazard && w.hazard !== 'other') params.set('hazard', w.hazard);
    if (w.nws_id) params.set('nws_id', w.nws_id);
    const body = warningBodySeed(w);
    if (body) params.set('body', body);
    return `/compose?${params.toString()}`;
  }, []);

  const goToCompose = () => {
    if (!selection) return;
    const params = new URLSearchParams();
    if (selection.type === 'circle') {
      params.set('geo', JSON.stringify({ type: 'circle', center: selection.center, radius_km: selection.radius_km }));
    } else {
      params.set('geo', JSON.stringify({ type: 'polygon', coordinates: selection.coordinates }));
    }
    window.open(`/compose?${params.toString()}`, '_blank', 'noopener,noreferrer');
  };

  // Hand off the polygon selection to /forecast/new for the operator to
  // attach hazards + a time window + discussion. /forecast only handles
  // polygon areas today, so the circle path is intentionally omitted.
  const goToForecast = () => {
    if (!selection || selection.type !== 'polygon') return;
    const params = new URLSearchParams();
    params.set('geo', JSON.stringify({ type: 'polygon', coordinates: selection.coordinates }));
    window.location.href = `/forecast/new?${params.toString()}`;
  };

  // Playback driver. Uses setTimeout so the dwell-at-NOW pause is variable per
  // frame; re-runs whenever frame changes, which is cheap and predictable.
  useEffect(() => {
    if (!playing || !useLibreWxR || totalFrames <= 1) return;
    const baseMs = { '0.5x': 800, '1x': 400, '2x': 220, '4x': 110 }[speed] ?? 400;
    // Pause briefly when we land on the most-recent observed frame so the
    // viewer can read the "now" state before the loop continues into nowcast
    // (or wraps back to the oldest past frame).
    const dwell = frame === lwxrPastCount - 1 ? Math.max(baseMs * 4, 1400) : baseMs;
    const id = setTimeout(() => {
      setFrame((f) => (f + 1) % totalFrames);
    }, dwell);
    return () => clearTimeout(id);
  }, [playing, speed, useLibreWxR, totalFrames, lwxrPastCount, frame]);

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
    if (!useLibreWxR || totalFrames <= 1) return;
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
        setFrame(Math.max(0, lwxrPastCount - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [useLibreWxR, totalFrames, lwxrPastCount]);

  // 'H' toggles hide-all-UI mode. Lives in its own effect (not the LWXR
  // playback handler above) so it works in every product/mode, not only
  // when a timeline is available.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setUiHidden((v) => !v);
      } else if (e.key === 'Escape') {
        // Esc cancels any in-progress draw or clears the active selection.
        // setState calls are no-ops when there's nothing to clear, so it's
        // safe to fire unconditionally.
        setDrawMode('none');
        setPolygonPoints([]);
        setSelection(null);
        setPreviewCount(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Audience breakdown is resolved server-side now — the old version bucketed
  // subscribers by name substring ("memphis"/"bartlett" → memphis bucket) which
  // broke whenever a subscriber's display name didn't match the hardcoded list.
  // resolve_audience_breakdown() returns counts grouped by state via
  // subscribers.county_fips, which is authoritative.
  useEffect(() => {
    if (!selection) {
      setAudienceBreakdown({ total: 0, tn: 0, ms: 0, ar: 0, other: 0 });
      return;
    }
    const supa = supabaseBrowser();
    const spec =
      selection.type === 'circle'
        ? { geometry: { type: 'circle', center: selection.center, radius_km: selection.radius_km } }
        : { geometry: { type: 'Polygon', coordinates: [selection.coordinates] } };
    let cancelled = false;
    (async () => {
      const { data, error } = await supa.rpc('resolve_audience_breakdown', { spec });
      if (cancelled || error || !data) return;
      const d = data as Partial<AudienceBreakdown>;
      setAudienceBreakdown({
        total: Number(d.total ?? 0),
        tn:    Number(d.tn ?? 0),
        ms:    Number(d.ms ?? 0),
        ar:    Number(d.ar ?? 0),
        other: Number(d.other ?? 0),
      });
    })();
    return () => { cancelled = true; };
  }, [selection]);

  const focusWarning = (w: NwsWarning) => {
    mapRef.current?.flyTo({ center: w.centroid, zoom: 8.5, duration: 800 });
  };

  // Geographic pills anchored at each NEXRAD site visible in the viewport.
  // Off entirely when the operator toggles them or zooms out below z5; the
  // selected site is always included so it doesn't vanish on pan.
  const mapPillSites = useMemo<RadarSite[]>(() => {
    if (!showSitePills) {
      if (!selectedSite) return [];
      const sel = NEXRAD_SITES_BY_CODE[selectedSite];
      return sel ? [sel] : [];
    }
    const zoom = settledView.zoom;
    const center: [number, number] = [settledView.longitude, settledView.latitude];
    const cap = mapPillCapForZoom(zoom);
    if (cap === 0) {
      if (!selectedSite) return [];
      const sel = NEXRAD_SITES_BY_CODE[selectedSite];
      return sel ? [sel] : [];
    }

    const inView = mapBounds
      ? NEXRAD_SITES.filter((s) => {
          const [lon, lat] = s.center;
          return lon >= mapBounds.west && lon <= mapBounds.east
            && lat >= mapBounds.south && lat <= mapBounds.north;
        })
      : nearestSites(center, Math.max(cap, 12));

    const pool = inView.length > 0 ? inView : nearestSites(center, cap === Infinity ? 24 : cap);
    const ranked = pool
      .map((s) => ({ s, d: distanceKm(center, s.center) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, cap === Infinity ? pool.length : cap)
      .map((x) => x.s);

    if (selectedSite && !ranked.some((s) => s.code === selectedSite)) {
      const sel = NEXRAD_SITES_BY_CODE[selectedSite];
      if (sel) ranked.push(sel);
    }
    return ranked;
  }, [mapBounds, settledView.zoom, settledView.longitude, settledView.latitude, selectedSite, showSitePills]);

  const screenPoint = (lngLat: [number, number]) => {
    const map = mapRef.current?.getMap();
    return map ? map.project(lngLat) : null;
  };

  // Active frame's wall-clock time (LibreWxR = real timestamp; otherwise NOW).
  const frameTimeLabel = useMemo(() => {
    let d: Date;
    if (useLibreWxR && lwxrAllFrames[frame]) {
      d = new Date(lwxrAllFrames[frame].time * 1000);
    } else {
      d = new Date();
    }
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }, [frame, useLibreWxR, lwxrAllFrames]);

  const isForecastFrame = useLibreWxR && frame >= lwxrPastCount;
  const relLabel = useMemo(() => {
    if (!useLibreWxR) return 'LIVE';
    const f = lwxrAllFrames[frame];
    if (!f) return '—';
    const nowSec = Math.floor(Date.now() / 1000);
    const diffMin = Math.round((f.time - nowSec) / 60);
    if (diffMin === 0) return 'NOW';
    return diffMin > 0 ? `+${diffMin} min` : `${diffMin} min`;
  }, [useLibreWxR, frame, lwxrAllFrames]);

  // F8: scrub-time replay. When the operator drags the LibreWxR timeline
  // back, return the past-frame timestamp (ms); otherwise null = live.
  // The latest past frame (lwxrPastCount - 1) is always treated as "live now"
  // — it's the freshest mosaic LibreWxR publishes, typically 5-10 min old,
  // and the operator expects current warnings to overlay it. Without this,
  // any warning issued in the last few minutes would be filtered out the
  // moment the page loads.
  const scrubTimeMs = useMemo<number | null>(() => {
    if (!useLibreWxR) return null;
    if (frame >= lwxrPastCount - 1) return null;
    const f = lwxrAllFrames[frame];
    if (!f) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (f.time >= nowSec - 60) return null;
    return f.time * 1000;
  }, [useLibreWxR, frame, lwxrAllFrames, lwxrPastCount]);

  const replayDiffMin = scrubTimeMs == null
    ? null
    : Math.round((scrubTimeMs - Date.now()) / 60_000);

  // F8: scrub-aware derivatives. Live mode (scrubTimeMs null) just passes
  // through. In replay mode, warnings are kept only if they were active at
  // the scrubbed timestamp (effective <= t < expires_at), and LSRs are
  // kept only if their occurred_at <= t.
  //
  // Plus a category gate (warning/watch/advisory/discussion). 'statement' and
  // 'other' tag along with warnings since they're rare and the operator hasn't
  // asked for finer control over them.
  const isCategoryVisible = useCallback(
    (cat: string) => {
      switch (cat) {
        case 'warning': return catWarnings;
        case 'watch': return catWatches;
        case 'advisory': return catAdvisories;
        case 'discussion': return catDiscussions;
        default: return catWarnings;
      }
    },
    [catWarnings, catWatches, catAdvisories, catDiscussions],
  );
  const displayWarnings = useMemo<NwsWarning[]>(() => {
    const t = scrubTimeMs;
    return warnings.filter((w) => {
      if (!isCategoryVisible(w.category)) return false;
      if (t == null) return true;
      const eff = w.effective ? new Date(w.effective).getTime() : -Infinity;
      const exp = w.expires_at ? new Date(w.expires_at).getTime() : Infinity;
      return eff <= t && exp > t;
    });
  }, [warnings, scrubTimeMs, isCategoryVisible]);
  const displayWarningsGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    const t = scrubTimeMs;
    return {
      type: 'FeatureCollection',
      features: (warningsGeo.features ?? []).filter((f) => {
        const p = f.properties as {
          effective?: string | null;
          expires_at?: string | null;
          category?: string | null;
        } | null;
        if (!isCategoryVisible(p?.category ?? 'warning')) return false;
        if (t == null) return true;
        const eff = p?.effective ? new Date(p.effective).getTime() : -Infinity;
        const exp = p?.expires_at ? new Date(p.expires_at).getTime() : Infinity;
        return eff <= t && exp > t;
      }),
    };
  }, [warningsGeo, scrubTimeMs, isCategoryVisible]);
  const displayLsrGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    if (scrubTimeMs == null) return lsrGeo;
    const t = scrubTimeMs;
    return {
      type: 'FeatureCollection',
      features: (lsrGeo.features ?? []).filter((f) => {
        const p = f.properties as { occurred_at?: string | null } | null;
        const occ = p?.occurred_at ? new Date(p.occurred_at).getTime() : Infinity;
        return occ <= t;
      }),
    };
  }, [lsrGeo, scrubTimeMs]);

  // Convert quantized `v` (0-255) to natural units for the hover readout.
  const sampleLabel = useMemo(() => {
    if (!hoverPixel || hoverPixel.sample == null) return '—';
    if (effectiveProduct === 'correlation') return `${hoverPixel.sample.toFixed(2)} ρhv`;
    if (effectiveProduct === 'velocity' && useLevel2) return `${hoverPixel.sample.toFixed(0)} kt`;
    return `${hoverPixel.sample.toFixed(0)} dBZ`;
  }, [hoverPixel, effectiveProduct, useLevel2]);

  // Register the lightning-bolt symbol image with Mapbox once the style is up.
  // Inline SVG keeps it a code-only change — no public/ asset.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map || map.hasImage('lightning-bolt')) return;
    const img = new Image(48, 72);
    img.onload = () => {
      if (!map.hasImage('lightning-bolt')) {
        map.addImage('lightning-bolt', img, { pixelRatio: 2 });
      }
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHTNING_BOLT_SVG)}`;
  }, [mapReady]);

  // Drive the bolt fade. Mapbox style expressions can't reference "now", so we
  // rebind the literal current time at 1 Hz and let the GPU-side `interpolate`
  // do the per-feature age math. Strikes < 0s old hold full opacity; strikes
  // ≥ LIGHTNING_FADE_MS old are invisible.
  useEffect(() => {
    if (!showLightning || !mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const tick = () => {
      if (!map.getLayer('lightning-bolts')) return;
      map.setPaintProperty('lightning-bolts', 'icon-opacity', [
        'interpolate', ['linear'],
        ['-', Date.now(), ['get', 't']],
        0, 1,
        LIGHTNING_FADE_MS, 0,
      ] as any);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [showLightning, mapReady]);

  return (
    <div className="h-[calc(100vh-3.5rem)] md:h-[calc(100vh-3.25rem)] flex flex-col bg-wx-ink text-wx-fg [contain:layout_paint]">
      <div className="flex-1 relative overflow-hidden">
        <div className={`absolute inset-0 ${splitProduct ? 'flex flex-row' : ''}`}>
        <div className={splitProduct ? 'relative h-full flex-1 min-w-0' : 'relative h-full w-full'}>
        <AnnotationToolbar {...annotations} />
        <Map
          ref={mapRef}
          initialViewState={viewState}
          // setViewState here is what keeps pill labels (zoom>=8 switches to
          // city name) and the live circle-radius hint following pan/zoom.
          // The heavy bounds + pill-list recompute is on `moveend` via
          // settleMapViewport — see handleMapLoad.
          onMove={(e) => setViewState(e.viewState)}
          onLoad={handleMapLoad}
          style={{ width: '100%', height: '100%', cursor: mapCursor }}
          mapLib={mapboxgl as any}
          mapStyle={styleUrl}
          // Force mercator — Mapbox Standard styles default to globe, which
          // our radar overlays (mercator-tile-anchored rasters + GeoJSON
          // fills) can't render onto correctly.
          projection={{ name: 'mercator' } as any}
          mapboxAccessToken={token || undefined}
          customAttribution={[
            // LibreWxR radar composite + CAP alert layers — required by their CC BY 4.0 license.
            '<a href="https://librewxr.net" target="_blank" rel="noopener noreferrer">© LibreWxR</a> (CC BY 4.0)',
            // NOAA NWS / NCEP single-site reflectivity, velocity, and Level II tiles. Public-domain
            // data, but a courtesy credit matches the convention of other operational radar viewers.
            '<a href="https://www.weather.gov" target="_blank" rel="noopener noreferrer">NOAA / NWS</a>',
          ].join(' · ')}
          dragPan={drawMode === 'none' && !annotations.isActive}
          scrollZoom={drawMode === 'none' && !annotations.isActive}
          dragRotate={false}
          touchZoomRotate={false}
          boxZoom={false}
          doubleClickZoom={!annotations.isActive}
          onClick={handleMapClick}
          onMouseMove={handleMapMouseMove}
          onMouseLeave={() => { setHoverPixel(null); setHoverSub(null); }}
          // Required so the AnnotationToolbar's "snapshot" button can read
          // pixels back out of the WebGL canvas via toDataURL(). Costs a
          // small amount of GPU memory; negligible for our render budget.
          preserveDrawingBuffer
        >
          {liveRadarSource && (
            <Source key={liveSourceKey} id={radarSourceId} {...liveRadarSource}>
              <Layer {...liveRadarLayer} />
            </Source>
          )}

          {/* Render only the ±LWXR_MOUNT_RADIUS frames around the current one
              as raster sources. Frame visibility is driven imperatively via
              setPaintProperty in the effect above. Tiles for unmounted frames
              stay in Mapbox's tile cache so re-entering the window is fast.
              maxzoom is fixed to LibreWxR's tile cap so Mapbox
              over-scales (instead of going blank) past city-level zoom. */}
          {useLibreWxR && lwxrMountedFrames.map((f) => (
            <Source
              key={lwxrSourceId(f.time)}
              id={lwxrSourceId(f.time)}
              type="raster"
              tiles={[lwxrFrameUrl(f)]}
              tileSize={LIBREWXR_TILE_SIZE}
              maxzoom={LIBREWXR_MAX_ZOOM}
            >
              <Layer
                id={lwxrLayerId(f.time)}
                type="raster"
                paint={LWXR_FRAME_PAINT}
                {...tileAnchor}
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

          {/* Forecast model overlay (Phase 3). Public WMS-backed raster
              source: HRRR REFC (IEM), NDFD T2M/Wind (nowCOAST), WPC QPF
              (NOAA mapservices). Key on overlay+hour so changing forecast
              hour replaces the source cleanly rather than fading. */}
          {activeModel && (
            <Source
              key={`model:${activeModel.id}:${modelHour}`}
              id="model-overlay-src"
              type="raster"
              tiles={[activeModel.tileUrl(modelHour)]}
              tileSize={512}
            >
              <Layer
                id="model-overlay-layer"
                type="raster"
                paint={{
                  'raster-opacity': modelOpacity / 100,
                  'raster-fade-duration': 120,
                  'raster-resampling': 'linear',
                }}
                {...tileAnchor}
              />
            </Source>
          )}

          {/* F10: MRMS MESH overlay. Above radar tiles, below labels/
              warnings/pins, so hail tracks read as part of the radar
              product band. ncWMS serves the GRIB2 variable directly with
              a default raster style + a hail-sized colorscalerange
              (0-75 mm ≈ 0-3 in). Window selector (30/60/120 min) lives in
              the layer panel — the URL changes when the operator picks a
              different accumulation, which swaps the SWR key and remounts
              the source. */}
          {showMesh && meshUrlPath && (
            <Source
              key={`mesh:${meshUrlPath}`}
              id="mesh-overlay-src"
              type="raster"
              tiles={[
                `https://thredds.ucar.edu/thredds/wms/${meshUrlPath}` +
                `?service=WMS&request=GetMap&version=1.3.0` +
                `&layers=${encodeURIComponent('MaxEstimatedSizeofHail_altitude_above_msl')}` +
                `&styles=raster%2Fdefault` +
                `&colorscalerange=5%2C75` +
                `&belowmincolor=transparent` +
                `&format=image/png&transparent=true` +
                `&width=256&height=256&crs=EPSG:3857` +
                `&bbox={bbox-epsg-3857}`,
              ]}
              tileSize={256}
            >
              <Layer
                id="mesh-overlay-layer"
                type="raster"
                paint={{
                  // Slightly translucent so reflectivity underneath remains
                  // legible. 0.7 reads as "real product, but layered".
                  'raster-opacity': 0.7,
                  'raster-fade-duration': 150,
                  'raster-resampling': 'linear',
                }}
                {...tileAnchor}
              />
            </Source>
          )}

          {/* F7: SPC categorical outlook layer. Below NWS warnings so an
              active warning polygon never gets obscured by the outlook
              wash; above radar so the operator can read risk regions over
              the storm field. */}
          <Source id="spc-source" type="geojson" data={spcGeo as any}>
            <Layer
              id="spc-fill"
              {...overlayAnchor}
              type="fill"
              layout={{ visibility: spcLayerVis }}
              paint={{
                'fill-color': SPC_FILL_EXPR,
                'fill-opacity': 0.25,
                'fill-antialias': true,
              }}
            />
            <Layer
              id="spc-line"
              {...overlayAnchor}
              type="line"
              layout={{ visibility: spcLayerVis, 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': SPC_LINE_EXPR,
                'line-width': 1.8,
                'line-opacity': 0.85,
              }}
            />
          </Source>

          {/* NWS forecast + fire zone outlines from /maps/nws-zones.geojson
              (generated by `npm run gen:zones`). Single static FeatureCollection
              of pre-simplified polygons — Mapbox handles ~7K features in a
              client GeoJSON source comfortably. Drawn between SPC outlooks
              and warnings so active warning polygons remain on top. */}
          <Source
            id="nws-zones-source"
            type="geojson"
            data="/maps/nws-zones.geojson"
          >
            <Layer
              id="nws-zones-forecast"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'kind'], 'forecast']}
              layout={{ visibility: showZones ? 'visible' : 'none', 'line-join': 'round' }}
              paint={{
                'line-color': '#e2e8f0',
                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 8, 1.4, 12, 2.2],
                'line-opacity': 0.85,
              }}
            />
            <Layer
              id="nws-zones-fire"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'kind'], 'fire']}
              layout={{ visibility: showZones ? 'visible' : 'none', 'line-join': 'round' }}
              paint={{
                'line-color': '#fda4af',
                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 8, 1.2, 12, 2],
                'line-opacity': 0.75,
                'line-dasharray': [3, 2],
              }}
            />
          </Source>

          <Source id="cap-warning-source" type="geojson" data={capWarningsGeo as any}>
            {/* CAP polygons styled distinctly from NWS warnings: sky-blue
                stroke with a 6/3 dash pattern + a low-opacity fill. Anchored
                under the NWS layers (added before storm-track-source) so
                NWS warnings remain visually dominant when both are shown. */}
            <Layer
              id="cap-warning-fill"
              {...overlayAnchor}
              type="fill"
              layout={{ visibility: showCap ? 'visible' : 'none' }}
              paint={{ 'fill-color': '#38bdf8', 'fill-opacity': 0.08 }}
            />
            <Layer
              id="cap-warning-line"
              {...overlayAnchor}
              type="line"
              layout={{ visibility: showCap ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': '#38bdf8',
                'line-width': 1.5,
                'line-dasharray': [6, 3],
                'line-opacity': 0.9,
              }}
            />
          </Source>

          <Source id="storm-track-source" type="geojson" data={tracksGeo as any}>
            <Layer
              id="storm-track-observed"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'segment'], 'observed']}
              layout={{ visibility: trackLayerVis, 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': STORM_TRACK_LINE_COLOR,
                'line-width': 3,
                'line-opacity': 0.95,
              }}
            />
            <Layer
              id="storm-track-forecast"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'segment'], 'forecast']}
              layout={{ visibility: trackLayerVis, 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': STORM_TRACK_LINE_COLOR,
                'line-width': 2.5,
                'line-opacity': 0.75,
                'line-dasharray': [2, 1.5],
              }}
            />
            <Layer
              id="storm-track-points"
              {...overlayAnchor}
              type="circle"
              filter={['==', ['get', 'segment'], 'observed']}
              layout={{ visibility: trackLayerVis }}
              paint={{
                'circle-radius': 4,
                'circle-color': STORM_TRACK_LINE_COLOR,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': 1.5,
              }}
            />
            {/* Rotating arrowhead at the forecast endpoint. Triangle glyph
                rotated to match storm motion (deg, clockwise from N) and
                pinned to the map's coordinate system so it doesn't spin
                with viewport tilt. */}
            <Layer
              id="storm-track-arrow"
              {...overlayAnchor}
              type="symbol"
              filter={['==', ['get', 'kind'], 'forecast-end']}
              layout={{
                visibility: trackLayerVis,
                'text-field': '▲',
                'text-size': 16,
                'text-rotate': ['get', 'motion_deg'],
                'text-rotation-alignment': 'map',
                'text-keep-upright': false,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-anchor': 'center',
              }}
              paint={{
                'text-color': STORM_TRACK_LINE_COLOR,
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.6,
              }}
            />
            {/* Upright speed label just above the arrow. text-offset moves
                it ~1 line-height up; text-rotation-alignment=viewport keeps
                it readable regardless of motion direction. */}
            <Layer
              id="storm-track-speed"
              {...overlayAnchor}
              type="symbol"
              filter={['==', ['get', 'kind'], 'forecast-end']}
              layout={{
                visibility: trackLayerVis,
                'text-field': ['concat', ['to-string', ['round', ['get', 'motion_kts']]], ' kt'],
                'text-size': 11,
                'text-anchor': 'bottom',
                'text-offset': [0, -1.2],
                'text-rotation-alignment': 'viewport',
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{
                'text-color': '#f8fafc',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.6,
              }}
            />
          </Source>

          {/* F4: Local Storm Reports overlay. Outer halo + solid inner pin
              so the report stands off the basemap even when it lands inside
              a colored warning polygon. */}
          <Source id="lsr-source" type="geojson" data={displayLsrGeo as any}>
            <Layer
              id="lsr-halo"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showLsr ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 7, 10, 10, 14, 14, 20],
                'circle-color': LSR_FILL_EXPR,
                'circle-opacity': 0.25,
                'circle-blur': 0.4,
              }}
            />
            <Layer
              id="lsr-pin"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showLsr ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 7, 5, 10, 7, 14, 10],
                'circle-color': LSR_FILL_EXPR,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': 1.5,
              }}
            />
          </Source>

          {/* F13: mPING crowdsource reports. Diamond glyph (rotated square)
              distinguishes citizen pings from the circular LSR pins, since
              the operator should treat them as lower-confidence ground
              truth. Same hazard palette as LSRs so a tornado mPING reads
              the same red as a tornado LSR. */}
          <Source id="mping-source" type="geojson" data={mpingGeo as any}>
            <Layer
              id="mping-pin"
              {...overlayAnchor}
              type="symbol"
              layout={{
                visibility: showMping ? 'visible' : 'none',
                'text-field': '◆',
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 7, 15, 10, 19],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-anchor': 'center',
              }}
              paint={{
                'text-color': LSR_FILL_EXPR,
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.4,
                'text-opacity': 0.95,
              }}
            />
          </Source>

          {/* F12: METAR surface obs — compact station plot. Pin colored
              by temperature (°C), wind arrow rotated to the direction the
              wind is going TOWARD (wdir + 180 is the FROM direction; the
              arrow glyph naturally points where it's headed), and a
              text label (T/Td/wind) that only appears at higher zooms to
              avoid clutter at CONUS view. Gusts shown in red. */}
          <Source id="metar-source" type="geojson" data={metarGeo as any}>
            <Layer
              id="metar-pin"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showMetar ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 7, 4.5, 10, 6],
                'circle-color': [
                  'case',
                  ['==', ['typeof', ['get', 'temp']], 'number'],
                  [
                    'interpolate', ['linear'], ['to-number', ['get', 'temp']],
                    -15, '#a5f3fc',
                    -5,  '#7dd3fc',
                    5,   '#60a5fa',
                    15,  '#34d399',
                    22,  '#fbbf24',
                    30,  '#fb923c',
                    38,  '#ef4444',
                  ],
                  '#94a3b8',
                ] as any,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': 1.2,
                'circle-opacity': 0.95,
              }}
            />
            <Layer
              id="metar-wind"
              {...overlayAnchor}
              type="symbol"
              filter={[
                'all',
                ['==', ['typeof', ['get', 'wdir']], 'number'],
                ['==', ['typeof', ['get', 'wspd']], 'number'],
                ['>', ['to-number', ['get', 'wspd']], 0],
              ]}
              layout={{
                visibility: showMetar ? 'visible' : 'none',
                'text-field': '↓',
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 12, 7, 16, 10, 22],
                'text-rotate': ['to-number', ['get', 'wdir']],
                'text-rotation-alignment': 'map',
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-anchor': 'center',
              }}
              paint={{
                // Gusts >= 35 kt or sustained >= 25 kt → red emphasis;
                // otherwise white. Visually flags the storm cores without
                // requiring the operator to open every popup.
                'text-color': [
                  'case',
                  ['>=', ['coalesce', ['to-number', ['get', 'wgst']], 0], 35], '#fca5a5',
                  ['>=', ['to-number', ['get', 'wspd']], 25],                  '#fde047',
                  '#f8fafc',
                ] as any,
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.4,
              }}
            />
            <Layer
              id="metar-label"
              {...overlayAnchor}
              type="symbol"
              minzoom={7}
              layout={{
                visibility: showMetar ? 'visible' : 'none',
                'text-field': [
                  'concat',
                  ['coalesce', ['get', 'icaoId'], ''],
                  '\n',
                  // Temp / dewp in °F so the operator doesn't context-switch.
                  // 1.8 * c + 32, rounded.
                  ['case',
                    ['==', ['typeof', ['get', 'temp']], 'number'],
                    ['concat', ['to-string', ['round', ['+', ['*', ['to-number', ['get', 'temp']], 1.8], 32]]], '°'],
                    '—',
                  ],
                  '/',
                  ['case',
                    ['==', ['typeof', ['get', 'dewp']], 'number'],
                    ['to-string', ['round', ['+', ['*', ['to-number', ['get', 'dewp']], 1.8], 32]]],
                    '—',
                  ],
                  ['case',
                    ['>', ['coalesce', ['to-number', ['get', 'wspd']], 0], 0],
                    ['concat', '\n', ['to-string', ['round', ['to-number', ['get', 'wspd']]]], 'kt'],
                    '',
                  ],
                ] as any,
                'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9, 10, 11, 13, 12],
                'text-anchor': 'top',
                'text-offset': [0, 0.9],
                'text-allow-overlap': false,
                'text-ignore-placement': false,
                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
              }}
              paint={{
                'text-color': '#e2e8f0',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.5,
              }}
            />
          </Source>

          <Source id="subs-source" type="geojson" data={subsGeo}>
            <Layer {...subsHaloLayer} />
            <Layer {...subsPinLayer} />
          </Source>

          {/* GOES-19 GLM lightning flashes — small yellow bolts that fade
              linearly over LIGHTNING_FADE_MS. Symbol layer with no click
              handler, so it never steals interaction from subs/LSR/warnings
              underneath. The `paint` here is just an initial value; the 1 Hz
              effect rebinds `icon-opacity` with the current Date.now(). */}
          <Source id="lightning-source" type="geojson" data={lightningGeo}>
            <Layer
              id="lightning-bolts"
              {...overlayAnchor}
              type="symbol"
              layout={{
                'icon-image': 'lightning-bolt',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-anchor': 'center',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.35, 8, 0.55, 12, 0.85],
                visibility: showLightning ? 'visible' : 'none',
              }}
              paint={{
                'icon-opacity': [
                  'interpolate', ['linear'],
                  ['-', Date.now(), ['get', 't']],
                  0, 1,
                  LIGHTNING_FADE_MS, 0,
                ] as any,
              }}
            />
          </Source>

          {/* NWS warning polygons mount LAST (just before the operator's draw
              layers) so warning fills + outlines paint on top of radar tiles,
              storm tracks, LSR pins, subscriber pins, lightning, and CAP. The
              operator's active selection still wins, by sitting below. */}
          <Source id="warning-source" type="geojson" data={displayWarningsGeo as any}>
            <Layer
              id="warning-fill"
              {...overlayAnchor}
              type="fill"
              layout={{ visibility: nwsLayerVis }}
              paint={WARNING_FILL_PAINT}
            />
            <Layer
              id="warning-line"
              {...overlayAnchor}
              type="line"
              filter={['all',
                ['!=', ['get', 'category'], 'watch'],
                ['!=', ['get', 'category'], 'discussion'],
              ]}
              layout={{ visibility: nwsLayerVis }}
              paint={WARNING_LINE_PAINT}
            />
            <Layer
              id="warning-line-watch"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'category'], 'watch']}
              layout={{ visibility: nwsLayerVis }}
              paint={WARNING_LINE_WATCH_PAINT}
            />
            <Layer
              id="warning-line-discussion"
              {...overlayAnchor}
              type="line"
              filter={['==', ['get', 'category'], 'discussion']}
              layout={{ visibility: nwsLayerVis, 'line-cap': 'round', 'line-join': 'round' }}
              paint={WARNING_LINE_DISCUSSION_PAINT}
            />
          </Source>

          {/* F9: NEXRAD velocity-couplet trails. Drawn FIRST so the pin sits
              on top of its own trail. LineString per track_id ordered
              past→present; dashed pattern + low opacity reads as "history"
              vs. the bright pin's "now". */}
          <Source id="couplet-tracks-source" type="geojson" data={coupletTracks as any}>
            <Layer
              id="couplet-trail"
              {...overlayAnchor}
              type="line"
              layout={{
                visibility: showCouplets ? 'visible' : 'none',
                'line-cap': 'round',
                'line-join': 'round',
              }}
              paint={{
                'line-color': '#d946ef',
                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.2, 8, 1.8, 12, 2.4],
                'line-opacity': 0.55,
                'line-dasharray': [2, 2],
              }}
            />
          </Source>

          {/* F9: latest-detection pin per track_id. Color graduates by max
              shear: amber under 60 kt (weak couplet), fuchsia 60-80 (meso),
              red 80+ (TVS-strength). Stroke thickness scales with
              volume_count so a circulation that's been around for 6 scans
              reads as more substantial than a single-scan blip. */}
          <Source id="couplet-pin-source" type="geojson" data={coupletGeo as any}>
            <Layer
              id="couplet-halo"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showCouplets ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 16, 12, 24],
                'circle-color': [
                  'case',
                  ['>=', ['get', 'max_shear_kt'], 80], '#ef4444',
                  ['>=', ['get', 'max_shear_kt'], 60], '#d946ef',
                  '#f59e0b',
                ] as any,
                'circle-opacity': 0.18,
                'circle-blur': 0.6,
              }}
            />
            <Layer
              id="couplet-pin"
              {...overlayAnchor}
              type="circle"
              layout={{ visibility: showCouplets ? 'visible' : 'none' }}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 8, 7, 12, 11],
                'circle-color': [
                  'case',
                  ['>=', ['get', 'max_shear_kt'], 80], '#ef4444',
                  ['>=', ['get', 'max_shear_kt'], 60], '#d946ef',
                  '#f59e0b',
                ] as any,
                'circle-stroke-color': '#0b1220',
                'circle-stroke-width': [
                  'interpolate', ['linear'],
                  ['get', 'volume_count'],
                  1, 1.2,
                  3, 2.0,
                  6, 3.0,
                ] as any,
              }}
            />
            <Layer
              id="couplet-label"
              {...overlayAnchor}
              type="symbol"
              layout={{
                visibility: showCouplets ? 'visible' : 'none',
                'text-field': ['get', 'track_id'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 11, 12, 13],
                'text-anchor': 'top',
                'text-offset': [0, 0.8],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
              }}
              paint={{
                'text-color': '#fde047',
                'text-halo-color': '#0b1220',
                'text-halo-width': 1.6,
              }}
            />
          </Source>

          {selection && selection.type === 'circle' && selectionCircleData && (
            <Source id="selection-circle" type="geojson" data={selectionCircleData}>
              <Layer id="sel-circle" type="circle" paint={selectionCirclePaint} {...overlayAnchor} />
            </Source>
          )}
          {selection && selection.type === 'polygon' && selectionPolyData && (
            <Source id="selection-poly" type="geojson" data={selectionPolyData}>
              <Layer id="sel-poly-fill" type="fill" paint={SEL_POLY_FILL_PAINT} {...overlayAnchor} />
              <Layer id="sel-poly-line" type="line" paint={SEL_POLY_LINE_PAINT} {...overlayAnchor} />
            </Source>
          )}

          {drawMode === 'polygon' && polygonPoints.length > 0 && polyDrawData && (
            <Source id="poly-draw" type="geojson" data={polyDrawData}>
              <Layer id="poly-line" type="line" paint={SEL_POLY_LINE_PAINT} {...overlayAnchor} />
            </Source>
          )}

          <AnnotationLayer geojson={annotations.geojson} />
        </Map>
        </div>
        {splitProduct && (
          <div className="relative h-full flex-1 min-w-0 border-l border-wx-line">
            <Map
              ref={altMapRef}
              initialViewState={viewState}
              // Right pane is read-only — main map drives the camera via a
              // useEffect below. Disabling interactions prevents the user
              // from accidentally desyncing the view.
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
              {altLiveRadarSource && (
                <Source key={altSourceKey} id="alt-radar-source" {...altLiveRadarSource}>
                  <Layer
                    id="alt-radar-layer"
                    type="raster"
                    paint={{
                      'raster-opacity': opacity / 100,
                      'raster-fade-duration': 200,
                      'raster-resampling': 'linear',
                    }}
                    {...tileAnchor}
                  />
                </Source>
              )}
            </Map>
            <div className="absolute top-2 left-2 z-10 px-2 py-1 rounded bg-wx-card/95 border border-wx-line text-[10px] uppercase tracking-wider font-bold text-wx-fg">
              {splitProduct === 'reflectivity' ? 'BREF' : splitProduct === 'velocity' ? 'BVEL' : splitProduct}
              <span className="ml-1.5 font-mono font-normal text-wx-mute">· {selectedSite ?? ''}</span>
            </div>
          </div>
        )}
        </div>

        {/* Products rail (left) */}
        {!uiHidden && (
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
                  className={`relative flex flex-col items-center justify-center gap-0.5 py-2 rounded-lg text-[10px] font-semibold tracking-wide transition ${active ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'text-wx-mute hover:text-wx-fg'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  {active && tilesLoading && (
                    <span
                      className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-wx-accent animate-pulse"
                      title="Fetching tiles…"
                    />
                  )}
                  <Icon size={20} className={active ? 'text-wx-accent' : ''} />
                  <span>{p.short}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Draw toolbar */}
        {!uiHidden && (
          <div className="absolute top-4 left-[100px] flex gap-2 items-center z-20">
            <button onClick={startPolygonDraw} className={`px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm flex items-center gap-1.5 ${drawMode === 'polygon' ? 'bg-wx-accent text-black border-wx-accent' : ''}`}>
              <Target size={14} /> Polygon
            </button>
            <button onClick={startSnapMode} className={`px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm flex items-center gap-1.5 ${drawMode === 'snap' ? 'bg-wx-accent text-black border-wx-accent' : ''}`}>
              <MousePointer2 size={14} /> Adopt alert
            </button>
            {drawMode === 'polygon' && (
              <button onClick={completePolygon} disabled={polygonPoints.length < 3} className="px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm disabled:opacity-50">Complete ({polygonPoints.length})</button>
            )}
            {drawMode === 'polygon' && polygonPoints.length >= 3 && previewCount != null && (
              <span className="px-2 py-1 rounded bg-wx-ink border border-wx-line text-[11px] font-mono text-wx-fg" title="Subscribers inside the in-progress polygon (live)">
                ~{previewCount} in area
              </span>
            )}
            {(drawMode !== 'none' || selection) && (
              <button onClick={cancelDraw} className="px-3 py-2 bg-wx-card border border-wx-line rounded-lg text-sm text-wx-mute hover:text-wx-danger hover:border-wx-danger flex items-center gap-1.5">
                <Trash2 size={14} /> Clear
              </button>
            )}
            {drawMode === 'polygon' && polygonPoints.length === 0 && <div className="text-[11px]"><span className="px-1.5 py-0.5 text-[10px] border border-wx-line rounded bg-wx-ink">Click</span> add vertex</div>}
            {drawMode === 'snap' && <div className="text-[11px] text-wx-mute">Click any alert polygon</div>}
            {drawMode === 'pick-site' && <div className="text-[11px] text-wx-mute">Click the map to pick the nearest NEXRAD site</div>}
          </div>
        )}

        {!uiHidden && envWarnings && envWarnings.length > 0 && (
          <EnvPreflightBanner items={envWarnings} />
        )}

        {scrubTimeMs != null && (
          <div className={`absolute ${!uiHidden && envWarnings && envWarnings.length > 0 ? 'top-16' : 'top-4'} left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-3 py-1.5 rounded-lg border border-amber-400 bg-amber-500/15 backdrop-blur-sm shadow-lg text-amber-200`}>
            <span className="text-[10px] font-bold tracking-wider uppercase">Replay</span>
            <span className="text-xs">
              Showing {new Date(scrubTimeMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              {replayDiffMin != null ? <span className="text-amber-300/80"> · {replayDiffMin} min</span> : null}
              <span className="text-amber-200/70"> — alerts and reports filtered to this time</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setFrame(Math.max(0, lwxrPastCount - 1));
              }}
              className="text-[11px] font-semibold px-2 py-0.5 rounded border border-amber-400 hover:bg-amber-500/20"
            >
              Back to live
            </button>
          </div>
        )}

        {!uiHidden && showNws && displayWarnings.length > 0 && (
          <div
            className="wx-scroll absolute top-[68px] left-[100px] z-20 flex items-center gap-2 overflow-x-auto whitespace-nowrap pr-2"
            style={{ maxWidth: 'calc(100% - 100px - 340px)' }}
          >
            {displayWarnings.slice(0, 12).map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  setSelectedWarning(w);
                  focusWarning(w);
                }}
                className={`inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-wx-card/95 backdrop-blur-sm text-sm font-medium ${
                  selectedWarning?.id === w.id ? 'border-wx-accent bg-wx-accent/10' : ''
                } ${
                  w.category === 'warning' && w.hazard === 'tornado'
                    ? 'border-red-500/50 text-red-300'
                    : w.category === 'warning' && w.hazard === 'severe'
                      ? 'border-orange-500/50 text-orange-300'
                      : w.category === 'warning' && w.hazard === 'flood'
                        ? 'border-emerald-500/50 text-emerald-300'
                        : w.category === 'watch'
                          ? 'border-yellow-500/50 text-yellow-200'
                          : w.category === 'advisory'
                            ? 'border-violet-500/50 text-violet-200'
                            : w.category === 'discussion'
                              ? 'border-fuchsia-500/50 text-fuchsia-200'
                              : 'border-slate-500/50 text-slate-300'
                }`}
              >
                <span className="text-[9px] font-bold opacity-80">{categoryBadge(w.category)}</span>
                {w.label}
              </button>
            ))}
          </div>
        )}

        {/* Inspector — collapsed rail */}
        {!uiHidden && !selection && inspectorCollapsed && (
          <button
            type="button"
            onClick={() => setInspectorCollapsed(false)}
            className="absolute top-4 right-4 w-9 h-[120px] bg-wx-card border border-wx-line rounded-xl z-20 flex flex-col items-center justify-between py-2 hover:border-wx-accent group"
            aria-label="Expand inspector"
            title="Expand inspector"
          >
            <ChevronLeft size={14} className="text-wx-mute group-hover:text-wx-fg" />
            <div
              className={`flex-1 w-2 my-1 rounded-sm ${effectiveProduct === 'velocity' ? 'bg-[linear-gradient(180deg,#16a34a_0%,#22d3ee_25%,#e5e7eb_50%,#fb7185_75%,#b91c1c_100%)]' : effectiveProduct === 'rotation' ? 'bg-[linear-gradient(180deg,#1e1b4b_0%,#6d28d9_40%,#d946ef_70%,#fde047_100%)]' : effectiveProduct === 'correlation' ? 'bg-[linear-gradient(180deg,#1f2937_0%,#4b5563_30%,#6b7280_60%,#fbbf24_85%,#ef4444_100%)]' : effectiveProduct === 'satellite' ? 'bg-[linear-gradient(180deg,#0f172a_0%,#475569_35%,#cbd5e1_70%,#f8fafc_100%)]' : 'bg-[linear-gradient(180deg,#3b82f6_0%,#22d3ee_15%,#10b981_30%,#84cc16_45%,#facc15_60%,#f97316_75%,#ef4444_88%,#d946ef_100%)]'}`}
            />
            <span className="font-mono text-[9px] text-wx-mute">{PRODUCTS[effectiveProduct].short}</span>
          </button>
        )}

        {/* Inspector — expanded */}
        {!uiHidden && !selection && !inspectorCollapsed && (
          <div className="absolute top-4 right-4 w-[304px] max-h-[calc(100%-220px)] overflow-y-auto p-4 pt-7 bg-wx-card border border-wx-line rounded-xl flex flex-col gap-[18px] z-20 wx-scroll">
            <button
              type="button"
              onClick={() => setInspectorCollapsed(true)}
              className="absolute top-1.5 right-1.5 w-6 h-6 inline-flex items-center justify-center rounded-md text-wx-mute hover:text-wx-fg hover:bg-wx-ink"
              aria-label="Collapse inspector"
              title="Collapse inspector"
            >
              <ChevronRight size={14} />
            </button>
            <div>
              <div className="flex items-center justify-between text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                <span>Legend · {PRODUCTS[effectiveProduct].short}</span>
                <span className="font-mono text-[10px] text-wx-mute">
                  {(() => {
                    if (effectiveProduct === 'satellite' && satSource !== 'lwxr') {
                      return `GOES-East · ${GOES_SOURCES[satSource as GoesSourceId]?.short ?? 'SAT'}`;
                    }
                    if (lwxrSubject === 'satellite') return 'CONUS · LibreWxR IR';
                    if (useLibreWxR) return 'CONUS · LibreWxR';
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
                  {level2Loading && level2Attempt > 0 ? `Warming renderer · retry ${level2Attempt}/${level2MaxAttempts}…`
                    : level2Loading ? 'Rendering correlation coefficient…'
                    : level2Error === 'renderer_not_configured' ? 'Renderer not configured (see .env.local)'
                    : level2Error === 'renderer_waking' ? `Renderer waking up · retry ${level2Attempt}/${level2MaxAttempts}…`
                    : (level2Error === 'renderer_unreachable' || level2Error === 'renderer_timeout') ? 'Renderer slow — retrying…'
                    : level2Error ? `CC unavailable (${level2Error})`
                    : level2Overlay ? `Scan ${new Date(level2Overlay.scan_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} UTC`
                    : 'Waiting for Level II render…'}
                </p>
              )}
              {(() => {
                const satLegend: GoesLegend | null = effectiveProduct === 'satellite'
                  ? (satSource === 'lwxr' ? 'ir' : (GOES_SOURCES[satSource as GoesSourceId]?.legend ?? 'ir'))
                  : null;
                const satGradient =
                  satLegend === 'wv'   ? 'bg-[linear-gradient(90deg,#4a2f1c_0%,#92602f_25%,#cfa66d_45%,#4ade80_65%,#3b82f6_100%)]'
                  : satLegend === 'rgb' ? 'bg-[linear-gradient(90deg,#1e1b4b_0%,#3b82f6_25%,#10b981_50%,#fbbf24_75%,#ef4444_100%)]'
                  : 'bg-[linear-gradient(90deg,#0f172a_0%,#475569_35%,#cbd5e1_70%,#f8fafc_100%)]';
                const satLabels =
                  satLegend === 'wv'   ? ['Dry', '·', '·', 'Moist']
                  : satLegend === 'rgb' ? ['RGB composite']
                  : ['Warm', '·', '·', 'Cold cloud tops'];
                return (
                  <>
                    <div className={`h-2.5 rounded-[3px] mt-1 ${effectiveProduct === 'velocity' ? 'bg-[linear-gradient(90deg,#16a34a_0%,#22d3ee_25%,#e5e7eb_50%,#fb7185_75%,#b91c1c_100%)]' : effectiveProduct === 'rotation' ? 'bg-[linear-gradient(90deg,#1e1b4b_0%,#6d28d9_40%,#d946ef_70%,#fde047_100%)]' : effectiveProduct === 'correlation' ? 'bg-[linear-gradient(90deg,#1f2937_0%,#4b5563_30%,#6b7280_60%,#fbbf24_85%,#ef4444_100%)]' : effectiveProduct === 'satellite' ? satGradient : 'bg-[linear-gradient(90deg,#3b82f6_0%,#22d3ee_15%,#10b981_30%,#84cc16_45%,#facc15_60%,#f97316_75%,#ef4444_88%,#d946ef_100%)]'}`} />
                    <div className="flex justify-between text-[9.5px] font-mono text-wx-mute mt-1">
                      {effectiveProduct === 'velocity' && ['−64', '−32', '0', '+32', '+64 kts'].map(t => <span key={t}>{t}</span>)}
                      {effectiveProduct === 'rotation' && ['0', '0.005', '0.010', '0.015', '0.020 s⁻¹'].map(t => <span key={t}>{t}</span>)}
                      {effectiveProduct === 'correlation' && ['0.2', '0.5', '0.8', '0.95', '1.0'].map(t => <span key={t}>{t}</span>)}
                      {effectiveProduct === 'satellite' && satLabels.map((t, i) => <span key={`${t}-${i}`}>{t}</span>)}
                      {(effectiveProduct === 'composite' || effectiveProduct === 'reflectivity') && ['5', '15', '25', '35', '45', '55', '65', '75 dBZ'].map(t => <span key={t}>{t}</span>)}
                    </div>
                  </>
                );
              })()}
            </div>

            <div className="border-t border-wx-line/40 -mt-2 pt-3 flex flex-col gap-[18px]">
              <button
                type="button"
                onClick={() => toggleInspectorSection('source')}
                className="flex items-center justify-between w-full text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold hover:text-wx-fg"
                aria-expanded={inspectorSections.source}
              >
                <span>Source</span>
                <ChevronDown size={12} className={`transition ${inspectorSections.source ? '' : '-rotate-90'}`} />
              </button>
              {inspectorSections.source && (<>

            {effectiveProduct === 'satellite' && (
              <div>
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">Satellite source</div>
                <select
                  value={satSource}
                  onChange={(e) => setSatSource(e.target.value as SatSourceId)}
                  className="w-full text-[11px] font-mono bg-wx-ink border border-wx-line rounded px-2 py-1 text-wx-fg"
                  title="Switch between LibreWxR's modeled IR (animated) and real GOES-East ABI bands (live single frame)"
                >
                  <option value="lwxr">LibreWxR IR · modeled · animated</option>
                  {(Object.keys(GOES_SOURCES) as GoesSourceId[]).map((id) => (
                    <option key={id} value={id}>{GOES_SOURCES[id].label}</option>
                  ))}
                </select>
                {satSource !== 'lwxr' && (() => {
                  const cfg = GOES_SOURCES[satSource as GoesSourceId];
                  const upstream = cfg?.provider === 'iem' ? 'Iowa State Mesonet' : 'NASA GIBS';
                  return (
                    <p className="text-[9.5px] text-wx-mute mt-1 leading-snug">
                      Live single frame via {upstream} · GOES-East ABI · ~10 min cadence
                    </p>
                  );
                })()}
              </div>
            )}

            {lwxrSubject === 'radar' && (
              <div>
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">LibreWxR</div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-wx-mute">Motion arrows</span>
                  <button
                    onClick={() => setShowArrows((v) => !v)}
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showArrows ? 'bg-amber-400' : 'bg-wx-line'}`}
                    aria-pressed={showArrows}
                    title={showArrows ? 'Hide storm-motion arrows' : 'Show storm-motion arrows'}
                  >
                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showArrows ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-wx-mute">Color scheme</span>
                  <select
                    value={colorScheme}
                    onChange={(e) => setColorScheme(parseInt(e.target.value, 10))}
                    className="text-[10px] font-mono bg-wx-ink border border-wx-line rounded px-1.5 py-0.5 text-wx-fg"
                    title="LibreWxR radar color scheme"
                  >
                    {LIBREWXR_COLOR_SCHEMES.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

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
                <button onClick={() => { setSelectedSite(null); setSiteQuery(''); }} className={`flex-1 py-1.5 text-sm font-medium ${!selectedSite ? 'bg-wx-card text-wx-fg' : 'text-wx-mute'}`}>CONUS</button>
                <button
                  onClick={() => {
                    if (!selectedSite) {
                      const center: [number, number] = [viewState.longitude, viewState.latitude];
                      const nearest = nearestSites(center, 1)[0] ?? NEXRAD_SITES_BY_CODE[DEFAULT_SITE_CODE];
                      setSelectedSite(nearest.code);
                      mapRef.current?.flyTo({ center: nearest.center, zoom: nearest.zoom, duration: 700 });
                    }
                  }}
                  className={`flex-1 py-1.5 text-sm font-medium border-l border-wx-line ${selectedSite ? 'bg-wx-card text-wx-fg' : 'text-wx-mute'}`}
                >Single site</button>
              </div>
              {selectedSite && (
                <div className="mt-2 flex flex-col gap-1.5">
                  <div className="relative">
                    <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-wx-mute pointer-events-none" />
                    <input
                      type="text"
                      value={siteQuery}
                      onChange={(e) => setSiteQuery(e.target.value)}
                      placeholder="Search NEXRAD (KOHX, Nashville, TN…)"
                      className="w-full pl-7 pr-7 py-1.5 text-[11.5px] bg-wx-ink border border-wx-line rounded-md placeholder:text-wx-mute focus:border-wx-accent outline-none"
                    />
                    {siteQuery && (
                      <button
                        onClick={() => setSiteQuery('')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-wx-mute hover:text-wx-fg"
                        title="Clear"
                      ><X size={11} /></button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDrawMode((m) => (m === 'pick-site' ? 'none' : 'pick-site'))}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10.5px] border ${drawMode === 'pick-site' ? 'bg-wx-accent text-black border-wx-accent' : 'bg-wx-ink/40 border-wx-line text-wx-mute hover:text-wx-fg'}`}
                    title="Click anywhere on the map to pick the nearest NEXRAD site"
                  >
                    <Target size={11} /> {drawMode === 'pick-site' ? 'Click the map…' : 'Pick by clicking map'}
                  </button>

                  {!siteQuery && recentSiteCodes.length > 0 && (
                    <>
                      <div className="text-[9.5px] uppercase tracking-wider text-wx-mute font-semibold">Recent</div>
                      <div className="grid grid-cols-1 gap-0.5">
                        {recentSiteCodes
                          .map((c) => NEXRAD_SITES_BY_CODE[c])
                          .filter((s): s is RadarSite => !!s)
                          .map((s) => {
                            const active = selectedSite === s.code;
                            return (
                              <button
                                key={`recent-${s.code}`}
                                onClick={() => {
                                  mapRef.current?.flyTo({ center: s.center, zoom: s.zoom, duration: 700 });
                                  setSelectedSite(s.code);
                                }}
                                className={`w-full text-left px-2 py-1 rounded text-[11.5px] flex items-center gap-2 transition ${active ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'hover:bg-wx-ink/60 text-wx-mute hover:text-wx-fg'}`}
                              >
                                <span className="font-mono text-[10px] text-wx-accent w-[44px] flex-shrink-0">{s.code}</span>
                                <span className="flex-1 truncate">{s.name}</span>
                                <span className="text-[9.5px] font-mono text-wx-mute/70 flex-shrink-0">{s.state}</span>
                              </button>
                            );
                          })}
                      </div>
                    </>
                  )}
                  <div className="text-[9.5px] uppercase tracking-wider text-wx-mute font-semibold flex items-center justify-between">
                    <span>{siteQuery ? `Matches · ${pickerSites.length}` : 'Nearest sites'}</span>
                    <span className="font-mono text-wx-mute/70 normal-case tracking-normal">{NEXRAD_SITES.length} CONUS</span>
                  </div>
                  <div className="max-h-[220px] overflow-y-auto wx-scroll pr-0.5 -mr-0.5">
                    {pickerSites.length === 0 && (
                      <p className="text-[11px] text-wx-mute px-1 py-2">No matches — try a code (KTLX), city, or state code (OK).</p>
                    )}
                    <div className="grid grid-cols-1 gap-0.5">
                      {pickerSites.map((s) => {
                        const active = selectedSite === s.code;
                        const distanceFrom: [number, number] = pickerCenter ?? [settledView.longitude, settledView.latitude];
                        const km = distanceKm(distanceFrom, s.center);
                        return (
                          <button
                            key={s.code}
                            onClick={() => {
                              mapRef.current?.flyTo({ center: s.center, zoom: s.zoom, duration: 700 });
                              setSelectedSite(s.code);
                            }}
                            className={`w-full text-left px-2 py-1 rounded text-[11.5px] flex items-center gap-2 transition ${active ? 'bg-wx-ink border border-wx-line text-wx-fg' : 'hover:bg-wx-ink/60 text-wx-mute hover:text-wx-fg'}`}
                          >
                            <span className="font-mono text-[10px] text-wx-accent w-[44px] flex-shrink-0">{s.code}</span>
                            <span className="flex-1 truncate">{s.name}</span>
                            <span className="text-[9.5px] font-mono text-wx-mute/70 flex-shrink-0">{s.state} · {Math.round(km)}km</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              {selectedSite && (effectiveProduct === 'reflectivity' || effectiveProduct === 'velocity') && (
                <div className="pt-3 border-t border-wx-line mt-1">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">Split view</div>
                      <div className="text-[10px] text-wx-mute">
                        {effectiveProduct === 'reflectivity' ? 'BREF | BVEL' : 'BVEL | BREF'}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (splitProduct) {
                          setSplitProduct(null);
                        } else {
                          setSplitProduct(effectiveProduct === 'reflectivity' ? 'velocity' : 'reflectivity');
                        }
                      }}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${splitProduct ? 'bg-wx-accent' : 'bg-wx-line'}`}
                      aria-pressed={!!splitProduct}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${splitProduct ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                    </button>
                  </label>
                  <label className="flex items-center justify-between cursor-pointer mt-2.5 pt-2.5 border-t border-wx-line/40">
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
                  {hiRes && level2Loading && (
                    <p className="text-[10px] text-wx-mute mt-1">
                      {level2Attempt > 0
                        ? `Warming renderer · retry ${level2Attempt}/${level2MaxAttempts}…`
                        : 'Rendering…'}
                    </p>
                  )}
                  {hiRes && level2Error === 'renderer_waking' && !level2Loading && (
                    <p className="text-[10px] text-amber-300/90 mt-1">
                      Renderer cold-start · retry {level2Attempt}/{level2MaxAttempts} in progress
                    </p>
                  )}
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

              </>)}
            </div>

            <div className="border-t border-wx-line/40 -mt-2 pt-3 flex flex-col gap-[18px]">
              <button
                type="button"
                onClick={() => toggleInspectorSection('overlays')}
                className="flex items-center justify-between w-full text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold hover:text-wx-fg"
                aria-expanded={inspectorSections.overlays}
              >
                <span>Overlays</span>
                <ChevronDown size={12} className={`transition ${inspectorSections.overlays ? '' : '-rotate-90'}`} />
              </button>
              {inspectorSections.overlays && (<>

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

              <div className="flex items-center justify-between mb-1">
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                  NWS alerts · {displayWarnings.length}
                  {scrubTimeMs != null && warnings.length !== displayWarnings.length
                    ? <span className="text-wx-mute font-normal normal-case"> / {warnings.length} loaded</span>
                    : null}
                  {warningsLoading ? <span className="text-wx-mute font-normal normal-case"> · updating</span> : null}
                </div>
                <button
                  onClick={() => setShowNws((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showNws ? 'bg-amber-400' : 'bg-wx-line'}`}
                  aria-pressed={showNws}
                  title={showNws ? 'Hide NWS polygons' : 'Show NWS polygons'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showNws ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {showNws && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 mb-2 text-[10.5px]">
                  <CategoryCheckbox label="Warnings" tint="text-red-300" on={catWarnings}      toggle={() => setCatWarnings((v) => !v)}      count={warnings.filter((w) => ['warning'].includes(w.category)).length} />
                  <CategoryCheckbox label="Watches"  tint="text-yellow-200" on={catWatches}    toggle={() => setCatWatches((v) => !v)}        count={warnings.filter((w) => w.category === 'watch').length} />
                  <CategoryCheckbox label="Advisories" tint="text-violet-200" on={catAdvisories} toggle={() => setCatAdvisories((v) => !v)} count={warnings.filter((w) => w.category === 'advisory').length} />
                  <CategoryCheckbox label="SPC MDs"  tint="text-fuchsia-200" on={catDiscussions} toggle={() => setCatDiscussions((v) => !v)} count={warnings.filter((w) => w.category === 'discussion').length} />
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Storm tracks · {stormTrackCount} storm{stormTrackCount === 1 ? '' : 's'}
                  {stormTrackCount === 0 ? ' (none with NWS motion data)' : ''}
                </span>
                <button
                  onClick={() => setShowStormTracks((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showStormTracks ? 'bg-sky-400' : 'bg-wx-line'}`}
                  aria-pressed={showStormTracks}
                  title={showStormTracks ? 'Hide storm tracks' : 'Show storm tracks'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showStormTracks ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Storm reports · {displayLsrGeo.features?.length ?? 0} (last 6h)
                </span>
                <button
                  onClick={() => setShowLsr((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showLsr ? 'bg-red-400' : 'bg-wx-line'}`}
                  aria-pressed={showLsr}
                  title={showLsr ? 'Hide NWS storm reports' : 'Show NWS storm reports'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showLsr ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Lightning (GLM) · {lightningGeo.features.length} flash{lightningGeo.features.length === 1 ? '' : 'es'}
                </span>
                <button
                  onClick={() => setShowLightning((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showLightning ? 'bg-yellow-400' : 'bg-wx-line'}`}
                  aria-pressed={showLightning}
                  title={showLightning ? 'Hide GOES-19 GLM lightning' : 'Show GOES-19 GLM lightning'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showLightning ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  Rotation IDs · {coupletGeo.features?.length ?? 0} active
                  {coupletsSwr.isLoading && showCouplets ? ' · updating' : ''}
                </span>
                <button
                  onClick={() => setShowCouplets((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showCouplets ? 'bg-fuchsia-400' : 'bg-wx-line'}`}
                  aria-pressed={showCouplets}
                  title={showCouplets ? 'Hide NEXRAD velocity-couplet IDs' : 'Show NEXRAD velocity-couplet IDs'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showCouplets ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {/* F13: mPING crowdsource reports overlay. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  mPING reports · {mpingGeo.features?.length ?? 0} (last 3h)
                  {showMping && mpingSwr.isLoading ? ' · updating' : ''}
                </span>
                <button
                  onClick={() => setShowMping((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showMping ? 'bg-orange-400' : 'bg-wx-line'}`}
                  aria-pressed={showMping}
                  title={showMping ? 'Hide mPING crowdsource reports' : 'Show mPING crowdsource reports'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showMping ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {/* F12: METAR surface obs overlay. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  METAR obs · {metarGeo.features?.length ?? 0} stations
                  {showMetar && metarSwr.isLoading ? ' · updating' : ''}
                </span>
                <button
                  onClick={() => setShowMetar((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showMetar ? 'bg-cyan-400' : 'bg-wx-line'}`}
                  aria-pressed={showMetar}
                  title={showMetar ? 'Hide METAR surface obs' : 'Show METAR surface obs'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showMetar ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {/* F10: MRMS MESH (Max Estimated Size of Hail) overlay. */}
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-wx-mute">
                  Hail tracks (MESH) · last {meshWindow} min
                  {showMesh && meshSwr.isLoading ? ' · updating' : ''}
                  {showMesh && meshUrlPath === null && !meshSwr.isLoading ? ' · no data' : ''}
                </span>
                <button
                  onClick={() => setShowMesh((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showMesh ? 'bg-emerald-400' : 'bg-wx-line'}`}
                  aria-pressed={showMesh}
                  title={showMesh ? 'Hide MRMS MESH hail overlay' : 'Show MRMS MESH hail overlay'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showMesh ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {showMesh && (
                <div className="flex items-center gap-1 mb-2 ml-0.5">
                  {([30, 60, 120] as const).map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setMeshWindow(w)}
                      className={`px-1.5 py-0.5 rounded text-[9.5px] font-mono border transition ${
                        meshWindow === w
                          ? 'bg-emerald-500/20 border-emerald-400/70 text-emerald-200'
                          : 'bg-wx-card border-wx-line text-wx-mute hover:text-wx-fg'
                      }`}
                    >
                      {w}m
                    </button>
                  ))}
                  <span className="text-[9px] text-wx-mute ml-1">accumulation</span>
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  NWS zones · forecast + fire
                </span>
                <button
                  onClick={() => setShowZones((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showZones ? 'bg-slate-400' : 'bg-wx-line'}`}
                  aria-pressed={showZones}
                  title={showZones ? 'Hide NWS zone outlines' : 'Show NWS zone outlines'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showZones ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  NEXRAD site pills · {mapPillSites.length}
                </span>
                <button
                  onClick={() => setShowSitePills((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showSitePills ? 'bg-amber-400' : 'bg-wx-line'}`}
                  aria-pressed={showSitePills}
                  title={showSitePills ? 'Hide NEXRAD site pills (selected site still shown)' : 'Show NEXRAD site pills'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showSitePills ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* LibreWxR CAP polygons — sky-blue dashed overlay, complementary
                  to the NWS warning layer. Use to spot-check what the CAP
                  pipeline catches relative to NWS. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  CAP polygons (LibreWxR) · {capWarningsGeo.features.length}
                </span>
                <button
                  onClick={() => setShowCap((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showCap ? 'bg-sky-400' : 'bg-wx-line'}`}
                  aria-pressed={showCap}
                  title={showCap ? 'Hide LibreWxR CAP polygons' : 'Show LibreWxR CAP polygons'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showCap ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* F7: SPC convective outlook row + day picker. */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-wx-mute">
                  SPC outlook · Day {spcDay}
                  {activeSpc?.highest_label ? ` · ${activeSpc.highest_label}` : ''}
                </span>
                <button
                  onClick={() => setShowSpc((v) => !v)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${showSpc ? 'bg-orange-400' : 'bg-wx-line'}`}
                  aria-pressed={showSpc}
                  title={showSpc ? 'Hide SPC outlook' : 'Show SPC outlook'}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${showSpc ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {showSpc && (
                <div className="mb-2">
                  <div className="flex gap-1 mb-1">
                    {([1, 2, 3] as const).map((d) => {
                      const row = spcDays.find((r) => r.day_number === d);
                      const label = row?.highest_label ?? '—';
                      const active = spcDay === d;
                      return (
                        <button
                          key={d}
                          onClick={() => setSpcDay(d)}
                          className={`flex-1 px-2 py-1 rounded text-[10px] font-mono border transition ${active ? 'bg-wx-ink border-orange-400 text-wx-fg' : 'bg-wx-ink/40 border-wx-line text-wx-mute hover:text-wx-fg'}`}
                          title={row?.valid_from ? `Valid ${new Date(row.valid_from).toLocaleString()}` : 'Outlook not yet available'}
                        >
                          Day {d} · {label}
                        </button>
                      );
                    })}
                  </div>
                  {activeSpc?.issued_at ? (
                    <div className="text-[9.5px] font-mono text-wx-mute">
                      Issued {new Date(activeSpc.issued_at).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </div>
                  ) : (
                    <div className="text-[9.5px] text-wx-mute">No outlook fetched yet for Day {spcDay}.</div>
                  )}
                </div>
              )}
            </div>

              </>)}
            </div>

            <div className="border-t border-wx-line/40 -mt-2 pt-3 flex flex-col gap-[18px]">
              <button
                type="button"
                onClick={() => toggleInspectorSection('alerts')}
                className="flex items-center justify-between w-full text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold hover:text-wx-fg"
                aria-expanded={inspectorSections.alerts}
              >
                <span>Active alerts</span>
                <ChevronDown size={12} className={`transition ${inspectorSections.alerts ? '' : '-rotate-90'}`} />
              </button>
              {inspectorSections.alerts && (<>

            <div>
              {selectedWarning && (() => {
                const tint = alertTint(selectedWarning.category, selectedWarning.hazard);
                return (
                <div className={`mb-3 p-3 rounded-lg bg-wx-ink border ${tint.border} ${tint.bg} space-y-1.5`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className={`text-[11px] font-semibold ${tint.text}`}>{selectedWarning.event}</div>
                      {selectedWarning.ai_summary ? (
                        <p className="text-[10.5px] text-wx-fg/90 mt-0.5 line-clamp-3">
                          {selectedWarning.ai_summary}
                        </p>
                      ) : selectedWarning.headline ? (
                        <p className="text-[10.5px] text-wx-fg/85 mt-0.5 line-clamp-3">{selectedWarning.headline}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedWarning(null)}
                      className="text-wx-mute hover:text-wx-fg shrink-0"
                      aria-label="Clear selection"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="text-[10px] text-wx-mute">
                    {categoryBadge(selectedWarning.category)} · {selectedWarning.severity ?? '—'} · until{' '}
                    {selectedWarning.expires_at
                      ? new Date(selectedWarning.expires_at).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : '—'}
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <a href={`/nws/${selectedWarning.id}`} className="text-[11px] text-wx-accent font-medium">
                      Full NWS detail →
                    </a>
                    <a
                      href={composeUrlForWarning(selectedWarning)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-wx-accent text-black rounded-md text-[11px] font-semibold hover:bg-amber-300"
                      title="Send to subscribers in this polygon"
                    >
                      <Send size={11} /> Send to polygon
                    </a>
                  </div>
                  {selectedWarning.forecast_track && selectedWarning.in_path_count != null ? (
                    (() => {
                      const trackUrl = composeUrlForWarningTrack(selectedWarning);
                      if (!trackUrl) return null;
                      return (
                        <a
                          href={trackUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 border border-amber-400/50 text-amber-300 hover:bg-amber-400/10 rounded-md text-[11px] font-semibold w-full"
                          title={`Send to ${selectedWarning.in_path_count} subscribers in the storm's projected ${selectedWarning.in_path_corridor_km ?? 8}km corridor`}
                        >
                          <Send size={11} />
                          Send to path · {selectedWarning.in_path_count} in {selectedWarning.in_path_corridor_km ?? 8}km
                        </a>
                      );
                    })()
                  ) : null}
                </div>
                );
              })()}
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto wx-scroll">
                {displayWarnings.slice(0, 12).map((w) => (
                  <div
                    key={w.id}
                    className={`flex items-center gap-2 p-2 rounded-lg bg-wx-ink border ${
                      selectedWarning?.id === w.id ? 'border-wx-accent' : 'border-wx-line'
                    } hover:border-wx-accent`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedWarning(w);
                        focusWarning(w);
                      }}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <span
                        className={`px-1.5 py-0.5 text-[9px] rounded shrink-0 ${
                          w.category === 'warning' && w.hazard === 'tornado'
                            ? 'bg-red-500/20 text-red-300'
                            : w.category === 'warning' && w.hazard === 'severe'
                              ? 'bg-orange-500/20 text-orange-300'
                              : w.category === 'warning' && w.hazard === 'flood'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : w.category === 'watch'
                                  ? 'bg-yellow-500/20 text-yellow-200'
                                  : w.category === 'advisory'
                                    ? 'bg-violet-500/20 text-violet-200'
                                    : w.category === 'discussion'
                                      ? 'bg-fuchsia-500/20 text-fuchsia-200'
                                      : 'bg-slate-500/20 text-slate-300'
                        }`}
                      >
                        {categoryBadge(w.category)}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[11.5px] font-semibold truncate">{w.event}</div>
                        <div className="text-[10px] text-wx-mute truncate">
                          {w.area_desc ?? '—'} · until{' '}
                          {w.expires_at
                            ? new Date(w.expires_at).toLocaleTimeString([], {
                                hour: 'numeric',
                                minute: '2-digit',
                              })
                            : '—'}
                        </div>
                        {w.in_path_count != null && w.in_path_count > 0 ? (
                          <div className="text-[9.5px] mt-0.5 text-amber-300/90 font-mono">
                            ⟶ {w.in_path_count} in path
                            {w.in_path_corridor_km ? ` (${w.in_path_corridor_km}km)` : ''}
                          </div>
                        ) : null}
                      </div>
                    </button>
                    {w.category === 'warning' && (
                      <a
                        href={composeUrlForWarning(w)}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-wx-mute hover:text-wx-accent hover:bg-wx-accent/10"
                        title="Send to subscribers in this polygon"
                        aria-label={`Send to subscribers in ${w.event} polygon`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Send size={12} />
                      </a>
                    )}
                  </div>
                ))}
                {displayWarnings.length === 0 && !warningsLoading && (
                  <p className="text-[11px] text-wx-mute">
                    {scrubTimeMs == null
                      ? 'No active NWS polygons with geometry right now.'
                      : 'No warnings were active at the scrubbed timestamp.'}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 mt-2 text-[9px] text-wx-mute">
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/60" /> Warning</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm border border-yellow-400 border-dashed" /> Watch</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-violet-400/40" /> Advisory</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-fuchsia-500/50" /> SPC MD</span>
                <span className="inline-flex items-center gap-1 w-full mt-1">
                  <span className="w-4 h-0.5 bg-orange-400 rounded" /> Track
                  <span className="w-4 h-0.5 border-t border-dashed border-orange-400/80" /> 1h forecast
                </span>
              </div>
            </div>

              </>)}
            </div>

            <div className="border-t border-wx-line/40 -mt-2 pt-3 flex flex-col gap-[18px]">
              <button
                type="button"
                onClick={() => toggleInspectorSection('forecasts')}
                className="flex items-center justify-between w-full text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold hover:text-wx-fg"
                aria-expanded={inspectorSections.forecasts}
              >
                <span>Models & discussion</span>
                <ChevronDown size={12} className={`transition ${inspectorSections.forecasts ? '' : '-rotate-90'}`} />
              </button>
              {inspectorSections.forecasts && (<>

            <div>
              <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold mb-1">
                Area Forecast Discussions
              </div>
              <AfdPanel />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10.5px] tracking-wider uppercase text-wx-mute font-semibold">
                  Forecast overlay
                </div>
                {activeModel ? (
                  <button
                    type="button"
                    onClick={() => setModelOverlay(null)}
                    className="text-[10px] text-wx-mute hover:text-wx-fg"
                  >
                    Clear ✕
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(MODEL_OVERLAYS) as ModelOverlayKey[]).map((k) => {
                  const m = MODEL_OVERLAYS[k];
                  const on = modelOverlay === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setModelOverlay(on ? null : k)}
                      className={`text-left px-2 py-1.5 rounded border text-[10.5px] font-semibold transition ${
                        on
                          ? 'border-wx-accent bg-wx-accent/10 text-wx-accent'
                          : 'border-wx-line text-wx-mute hover:text-wx-fg'
                      }`}
                      title={m.label}
                    >
                      <div>{m.short}</div>
                      <div className="text-[9px] font-normal text-wx-mute mt-0.5">{m.source}</div>
                    </button>
                  );
                })}
                {DISABLED_MODELS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    disabled
                    className="text-left px-2 py-1.5 rounded border border-wx-line text-[10.5px] font-semibold text-wx-mute opacity-40 cursor-not-allowed"
                    title={d.why}
                  >
                    <div>{d.label}</div>
                    <div className="text-[9px] font-normal text-wx-mute mt-0.5">no public WMS</div>
                  </button>
                ))}
              </div>

              {activeModel ? (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between text-[10.5px]">
                    <span className="text-wx-mute">Hour</span>
                    <span className="font-mono text-wx-fg">{activeModel.hourLabel(modelHour)}</span>
                  </div>
                  <input
                    type="range"
                    min={activeModel.hours.min}
                    max={activeModel.hours.max}
                    step={activeModel.hours.step}
                    value={modelHour}
                    onChange={(e) => setModelHour(parseInt(e.target.value, 10))}
                    className="wx-slider"
                  />
                  <div className="flex items-center justify-between text-[10.5px]">
                    <span className="text-wx-mute">Opacity</span>
                    <span className="font-mono text-wx-fg">{modelOpacity}%</span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={2}
                    value={modelOpacity}
                    onChange={(e) => setModelOpacity(parseInt(e.target.value, 10))}
                    className="wx-slider"
                  />
                  <p className="text-[10px] text-wx-mute leading-snug">{activeModel.legend}</p>
                  <p className="text-[9.5px] text-wx-mute/80">{activeModel.attribution}</p>
                </div>
              ) : (
                <p className="mt-2 text-[10px] text-wx-mute">
                  Pick a model to overlay forecast guidance on the live radar. Cleared on next refresh.
                </p>
              )}
            </div>

              </>)}
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

            <div className="grid grid-cols-4 gap-2 mt-3.5 pt-3.5 border-t border-wx-line">
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.tn}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">TN</div></div>
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.ms}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">MS</div></div>
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.ar}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">AR</div></div>
              <div className="bg-wx-ink border border-wx-line rounded-lg p-2.5"><div className="text-base font-bold">{audienceBreakdown.other}</div><div className="text-[10px] uppercase tracking-wide text-wx-mute mt-0.5">Other</div></div>
            </div>

            <button onClick={goToCompose} className="mt-3.5 w-full bg-wx-accent text-black rounded-lg font-semibold text-sm py-2 flex items-center justify-center gap-2 hover:bg-amber-300">
              <Send size={14} /> Send alert to area
            </button>
            {selection.type === 'polygon' && (
              <button
                onClick={goToForecast}
                className="mt-2 w-full bg-wx-ink border border-wx-line text-wx-fg rounded-lg font-semibold text-sm py-2 flex items-center justify-center gap-2 hover:border-wx-accent hover:text-wx-accent"
              >
                Forecast this area
              </button>
            )}
          </div>
        )}

        {/* Hide-all-UI toggle (always visible so we can get out of hidden mode). */}
        <button
          type="button"
          onClick={() => setUiHidden((v) => !v)}
          className="absolute bottom-4 right-4 z-30 w-9 h-9 inline-flex items-center justify-center rounded-lg bg-wx-card border border-wx-line text-wx-mute hover:text-wx-fg hover:border-wx-accent"
          aria-label={uiHidden ? 'Show UI (H)' : 'Hide UI (H)'}
          title={uiHidden ? 'Show UI (H)' : 'Hide UI (H)'}
          aria-pressed={uiHidden}
        >
          {uiHidden ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>

        {/* Timeline — drag to scrub, space to play, arrows to step. */}
        {useLibreWxR && totalFrames > 1 && (() => {
          const nowIdx = Math.max(0, lwxrPastCount - 1);
          const nowPct = (nowIdx / Math.max(1, totalFrames - 1)) * 100;
          const headPct = (frame / Math.max(1, totalFrames - 1)) * 100;
          const hoverFrameTime =
            hoverFrame != null && lwxrAllFrames[hoverFrame] ? lwxrAllFrames[hoverFrame].time : null;
          const nowSec = Math.floor(Date.now() / 1000);
          // Hour-grid labels. Radar covers ~2h past + ~1h nowcast at 10 min
          // intervals — show fine-grained marks around NOW. Satellite covers
          // 12h hourly with no forecast — use wider hourly marks.
          const labelMinutes: { mins: number; label: string }[] =
            lwxrSubject === 'satellite'
              ? [
                  { mins: -720, label: '−12h' },
                  { mins: -540, label: '−9h' },
                  { mins: -360, label: '−6h' },
                  { mins: -180, label: '−3h' },
                  { mins: 0, label: 'NOW' },
                ]
              : [
                  { mins: -120, label: '−2h' },
                  { mins: -60, label: '−1h' },
                  { mins: -30, label: '−30m' },
                  { mins: 0, label: 'NOW' },
                  { mins: 30, label: '+30m' },
                ];
          const snapTolSec = lwxrSubject === 'satellite' ? 40 * 60 : 20 * 60;
          const labels = labelMinutes
            .map(({ mins, label }) => {
              const target = nowSec + mins * 60;
              const idx = lwxrAllFrames.reduce(
                (best, f, i) => Math.abs(f.time - target) < Math.abs(lwxrAllFrames[best].time - target) ? i : best,
                0,
              );
              const diff = Math.abs(lwxrAllFrames[idx].time - target);
              if (diff > snapTolSec) return null;
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
                  <button
                    onClick={() => { setPlaying(false); setFrame(Math.max(0, lwxrPastCount - 1)); }}
                    disabled={frame === nowIdx}
                    className={`ml-1 px-2 h-9 rounded-md text-[10px] font-bold tracking-wider border transition disabled:opacity-40 disabled:cursor-default ${frame === nowIdx ? 'border-wx-line text-wx-mute' : 'border-wx-accent text-wx-accent hover:bg-wx-accent/10'}`}
                    title="Jump to live frame (N)"
                    aria-label="Jump to NOW"
                  >NOW</button>
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
                      {lwxrAllFrames.length > lwxrPastCount && (
                        <div
                          className="absolute right-0 top-0 bottom-0 bg-[repeating-linear-gradient(45deg,rgba(251,191,36,0.10)_0_5px,rgba(251,191,36,0.28)_5px_10px)] border-l border-amber-500/60"
                          style={{ width: `${100 - nowPct}%` }}
                        />
                      )}
                    </div>

                    {/* Frame ticks */}
                    <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between px-0.5 pointer-events-none">
                      {lwxrAllFrames.map((_, i) => (
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
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold tracking-wider uppercase ${
                    replayDiffMin != null
                      ? 'border-amber-400 text-amber-300'
                      : isForecastFrame
                        ? 'border-wx-accent text-wx-accent'
                        : 'border-wx-line text-wx-fg'
                  }`}>
                    {replayDiffMin != null
                      ? `REPLAY · ${replayDiffMin} min`
                      : isForecastFrame
                        ? 'NOWCAST'
                        : 'OBSERVED'}
                  </span>
                  <span className="text-[15px] font-bold tabular-nums">{frameTimeLabel}</span>
                  <span className="text-[11px] text-wx-mute tabular-nums">{relLabel}</span>
                </div>

                {(() => {
                  const order: ('0.5x' | '1x' | '2x' | '4x')[] = ['0.5x', '1x', '2x', '4x'];
                  const nextSpeed = order[(order.indexOf(speed) + 1) % order.length];
                  return (
                    <button
                      onClick={() => setSpeed(nextSpeed)}
                      className="text-[11px] px-2.5 py-1.5 border border-wx-line rounded-md hover:border-wx-accent font-mono tabular-nums flex items-center gap-1"
                      title={`Click for ${nextSpeed} (cycles 0.5× / 1× / 2× / 4×)`}
                    >
                      <span className="text-wx-fg font-semibold">{speed.replace('x', '×')}</span>
                      <span className="text-wx-mute text-[9.5px]">→ {nextSpeed.replace('x', '×')}</span>
                    </button>
                  );
                })()}
              </div>
              <div className="text-[10px] text-wx-mute text-center mt-1.5 font-mono">
                Space play/pause · ← → step · Home/End · N to jump to NOW
              </div>
            </div>
          );
        })()}

        {!useLibreWxR && (
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

        {/* F4: selected Local Storm Report card. Floats above the hover-pixel
            readout so the operator can dismiss without losing the cursor
            position. */}
        {selectedLsr && (
          <div className="absolute bottom-14 right-4 w-[280px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold">
                  NWS Storm Report{selectedLsr.source ? ` · ${selectedLsr.source}` : ''}
                </div>
                <div className="text-[12px] font-semibold text-wx-fg mt-0.5">
                  {selectedLsr.event}
                  {selectedLsr.magnitude ? <span className="ml-1.5 font-mono text-wx-accent">{selectedLsr.magnitude}</span> : null}
                </div>
                {selectedLsr.location ? (
                  <div className="text-[11px] text-wx-mute mt-0.5">{selectedLsr.location}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setSelectedLsr(null)}
                className="text-wx-mute hover:text-wx-fg shrink-0"
                aria-label="Clear selection"
              >
                <X size={14} />
              </button>
            </div>
            {selectedLsr.occurred_at ? (
              <div className="text-[10px] font-mono text-wx-mute">
                {new Date(selectedLsr.occurred_at).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </div>
            ) : null}
            {selectedLsr.remark ? (
              <p className="text-[10.5px] text-wx-fg/85 italic line-clamp-4">
                &quot;{selectedLsr.remark}&quot;
              </p>
            ) : null}
          </div>
        )}

        {/* F13: selected mPING report card. Compact — just description +
            age + a "lower confidence than LSR" reminder. The operator
            looks at this to decide whether to escalate from "possible"
            to "confirmed" before sending an alert. */}
        {selectedMping && (() => {
          const sm = selectedMping;
          const ageMin = sm.obtime
            ? Math.max(0, Math.round((Date.now() - new Date(sm.obtime).getTime()) / 60_000))
            : null;
          return (
            <div className="absolute bottom-14 right-4 w-[280px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold">
                    mPING · citizen report
                  </div>
                  <div className="text-[12px] font-semibold text-wx-fg mt-0.5">
                    {sm.description}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedMping(null)}
                  className="text-wx-mute hover:text-wx-fg shrink-0"
                  aria-label="Clear selection"
                >
                  <X size={14} />
                </button>
              </div>
              {ageMin != null ? (
                <div className="text-[10px] font-mono text-wx-mute">
                  {ageMin} min ago · hazard {sm.hazard}
                </div>
              ) : null}
              <div className="text-[10px] text-wx-mute/80 italic">
                Crowdsourced — verify before treating as confirmed ground truth.
              </div>
            </div>
          );
        })()}

        {/* F12: selected METAR station card. Single-line obs summary plus
            raw METAR for the operator who wants the full picture. Sits in
            the same lower-right slot as the LSR / couplet cards; only one
            of the three can be open at a time per click flow. */}
        {selectedMetar && (() => {
          const m = selectedMetar;
          const toF = (c: number | null) => c == null ? null : Math.round(c * 1.8 + 32);
          const tempF = toF(m.temp);
          const dewpF = toF(m.dewp);
          const ageMin = m.obsTime
            ? Math.max(0, Math.round((Date.now() - new Date(m.obsTime).getTime()) / 60_000))
            : null;
          return (
            <div className="absolute bottom-14 right-4 w-[300px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold">
                    METAR{ageMin != null ? ` · ${ageMin} min old` : ''}
                  </div>
                  <div className="text-[13px] font-mono font-bold text-cyan-200 mt-0.5">
                    {m.icaoId}
                  </div>
                  {m.name ? (
                    <div className="text-[10.5px] text-wx-mute mt-0.5 truncate">{m.name}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedMetar(null)}
                  className="text-wx-mute hover:text-wx-fg shrink-0"
                  aria-label="Clear selection"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px] font-mono">
                {tempF != null ? (
                  <div><span className="text-wx-mute/70">T</span> <span className="text-wx-fg">{tempF}°F</span></div>
                ) : null}
                {dewpF != null ? (
                  <div><span className="text-wx-mute/70">Td</span> <span className="text-wx-fg">{dewpF}°F</span></div>
                ) : null}
                {m.wspd != null && m.wspd > 0 ? (
                  <div className="col-span-2">
                    <span className="text-wx-mute/70">wind</span>{' '}
                    <span className="text-wx-fg">
                      {m.wdir != null ? `${Math.round(m.wdir)}°` : 'VRB'} @ {Math.round(m.wspd)} kt
                    </span>
                    {m.wgst != null && m.wgst > 0 ? (
                      <span className={`ml-1.5 ${m.wgst >= 35 ? 'text-red-300' : 'text-amber-200'}`}>
                        G{Math.round(m.wgst)}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="col-span-2 text-wx-mute/70">calm</div>
                )}
                {m.altim != null ? (
                  <div className="col-span-2 text-[10px] text-wx-mute">altim {m.altim.toFixed(0)} hPa</div>
                ) : null}
                {m.wxString ? (
                  <div className="col-span-2 text-amber-200">{m.wxString}</div>
                ) : null}
              </div>
              {m.rawOb ? (
                <pre className="mt-1 text-[9.5px] font-mono text-wx-mute/80 whitespace-pre-wrap break-all border-t border-wx-line/60 pt-1">{m.rawOb}</pre>
              ) : null}
            </div>
          );
        })()}

        {/* F9: selected NEXRAD velocity-couplet ("rotation ID") card.
            Volume_count + first_seen disambiguate a one-scan blip from a
            persistent circulation; "Alert from this rotation" pre-fills
            compose with an 8 km circle around the meso, ready to send. */}
        {selectedCouplet && (() => {
          const sc = selectedCouplet;
          const intensity = sc.max_shear_kt >= 80
            ? { label: 'TVS-strength', cls: 'text-red-300', dot: 'bg-red-400' }
            : sc.max_shear_kt >= 60
            ? { label: 'Meso',          cls: 'text-fuchsia-300', dot: 'bg-fuchsia-400' }
            : { label: 'Weak couplet',  cls: 'text-amber-300', dot: 'bg-amber-400' };
          const ageMin = sc.first_seen_at
            ? Math.max(0, Math.round((Date.now() - new Date(sc.first_seen_at).getTime()) / 60_000))
            : null;
          // F19a: signature-triggered phrasing. Body copy and audience
          // radius escalate with shear strength so the operator's default
          // alert matches the threat tier. Tier breakpoints align with the
          // pin's color (60 kt = meso, 80 kt = TVS-strength) so the visual
          // intensity and the language move together.
          const tier = sc.max_shear_kt >= 80
            ? 'tvs'
            : sc.max_shear_kt >= 60
            ? 'meso'
            : 'weak';
          const composeGeo = {
            type: 'circle' as const,
            center: [sc.lon, sc.lat] as [number, number],
            // Wider audience for stronger rotations — downstream impact
            // grows with intensity, and a TVS warrants pulling in
            // neighbors a township over.
            radius_km: tier === 'tvs' ? 12 : tier === 'meso' ? 9 : 6,
          };
          const ageStr = ageMin != null ? `${ageMin} min` : 'new';
          const persistStr = sc.volume_count >= 3 ? ', persistent' : '';
          const body =
            tier === 'tvs'
              ? `TORNADO LIKELY — strong rotation (${Math.round(sc.max_shear_kt)} kt gate-to-gate, ${ageStr}${persistStr}) on ${sc.site} radar at ${sc.track_id}. TAKE SHELTER NOW if you are in the affected area: lowest floor, interior room, away from windows. Stay sheltered until the threat passes.`
              : tier === 'meso'
              ? `Rotation observed — mesocyclone signature (${Math.round(sc.max_shear_kt)} kt, ${ageStr}${persistStr}) on ${sc.site} radar at ${sc.track_id}. Move to a safe shelter and monitor for a tornado warning. Do not wait for sirens.`
              : `Weak rotation under observation (${Math.round(sc.shear_kt)} kt, ${ageStr}) on ${sc.site} radar at ${sc.track_id}. Stay weather-aware and have a shelter plan ready in case it strengthens.`;
          const composeHref = `/compose?geo=${encodeURIComponent(JSON.stringify(composeGeo))}&hazard=tornado&body=${encodeURIComponent(body)}`;
          return (
            <div className="absolute bottom-14 right-4 w-[300px] p-3 bg-wx-card border border-wx-line rounded-xl z-30 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-wx-mute font-semibold flex items-center gap-1.5">
                    <span className={`inline-block h-2 w-2 rounded-full ${intensity.dot}`} />
                    Rotation ID · {sc.site}
                  </div>
                  <div className="text-[14px] font-mono font-bold text-fuchsia-200 mt-0.5">
                    {sc.track_id}
                  </div>
                  <div className={`text-[11px] mt-0.5 ${intensity.cls}`}>
                    {intensity.label} · {Math.round(sc.shear_kt)} kt gate-to-gate shear
                    {sc.max_shear_kt > sc.shear_kt
                      ? <span className="text-wx-mute"> (peak {Math.round(sc.max_shear_kt)})</span>
                      : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedCouplet(null)}
                  className="text-wx-mute hover:text-wx-fg shrink-0"
                  aria-label="Clear selection"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono text-wx-mute">
                <div><span className="text-wx-mute/70">range</span> {sc.range_km.toFixed(0)} km</div>
                <div><span className="text-wx-mute/70">az</span> {Math.round(sc.azimuth_deg)}°</div>
                <div><span className="text-wx-mute/70">tilt</span> {sc.elevation_deg.toFixed(1)}°</div>
                <div><span className="text-wx-mute/70">scans</span> {sc.volume_count}</div>
                {ageMin != null ? (
                  <div className="col-span-2"><span className="text-wx-mute/70">first seen</span> {ageMin} min ago</div>
                ) : null}
              </div>
              <a
                href={composeHref}
                target="_blank"
                rel="noreferrer"
                className="block w-full text-center px-2.5 py-1.5 text-[11px] font-semibold rounded-md bg-fuchsia-500/90 hover:bg-fuchsia-500 text-white"
              >
                Alert from this rotation →
              </a>
            </div>
          );
        })()}

        {/* NEXRAD site pills — one per radar location in the current view.
            Stays below the products rail / draw toolbar / inspector (z-20) so
            pills never sit on top of chrome controls. */}
        {mapPillSites.length > 0 && (
          <div className="absolute inset-0 pointer-events-none z-[15]">
            {mapPillSites.map((site) => {
              const isActive = selectedSite === site.code;
              const p = screenPoint(site.center);
              if (!p) return null;
              return (
                <div
                  key={site.code}
                  className="absolute pointer-events-auto"
                  style={{ left: p.x, top: p.y, transform: 'translate(-50%, -50%)' }}
                >
                  {isActive && (
                    <div
                      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[230px] h-[230px] rounded-full border border-dashed border-white/10 pointer-events-none"
                      style={{ background: 'radial-gradient(circle, rgba(251,191,36,0.06) 0%, transparent 70%)' }}
                    />
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedSite(site.code);
                      mapRef.current?.flyTo({ center: site.center, zoom: site.zoom, duration: 700 });
                    }}
                    title={`${site.code} · ${site.name}, ${site.state}`}
                    className={`relative inline-flex items-center whitespace-nowrap rounded-full font-mono font-semibold border backdrop-blur-sm transition ${
                      isActive
                        ? 'bg-wx-accent text-black border-wx-accent scale-105 px-2.5 py-1 text-[11px] shadow-lg'
                        : 'bg-wx-card border-wx-line text-wx-mute hover:text-wx-fg hover:border-wx-accent px-2 py-0.5 text-[10px]'
                    }`}
                  >
                    {sitePillLabel(site, viewState.zoom)}
                  </button>
                </div>
              );
            })}
          </div>
        )}

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
