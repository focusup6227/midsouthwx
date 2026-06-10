// Shared radar product + satellite source catalogs, extracted from RadarView
// so the inspector panel (RadarInspector) and the map view can both import
// them without a circular dependency.

import type * as React from 'react';
import {
  CloudLightning, Radio, Wind, Atom, RotateCw, Satellite, Droplets, CloudRain,
} from 'lucide-react';

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
export type ProductKey = 'composite' | 'reflectivity' | 'velocity' | 'correlation' | 'zdr' | 'kdp' | 'rotation' | 'satellite';

export type ProductMeta = {
  label: string;
  short: string;
  modes: { composite: boolean; site: boolean };
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
};

export const PRODUCTS: Record<ProductKey, ProductMeta> = {
  composite:    { label: 'Composite Reflectivity', short: 'CREF', modes: { composite: true,  site: false }, icon: CloudLightning },
  reflectivity: { label: 'Base Reflectivity',      short: 'BREF', modes: { composite: true,  site: true  }, icon: Radio },
  velocity:     { label: 'Storm-Rel Velocity',     short: 'SRV',  modes: { composite: false, site: true  }, icon: Wind },
  correlation:  { label: 'Correlation Coeff',      short: 'CC',   modes: { composite: false, site: true  }, icon: Atom },
  zdr:          { label: 'Differential Refl (ZDR)', short: 'ZDR', modes: { composite: false, site: true  }, icon: Droplets },
  kdp:          { label: 'Specific Diff Phase (KDP)', short: 'KDP', modes: { composite: false, site: true }, icon: CloudRain },
  rotation:     { label: 'Rotation (Az-Shear)',    short: 'ROT',  modes: { composite: true,  site: false }, icon: RotateCw },
  satellite:    { label: 'Satellite (IR cloud)',   short: 'SAT',  modes: { composite: true,  site: false }, icon: Satellite },
};

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
export type GoesSourceId =
  | 'goes-cleanir'
  | 'goes-geocolor'
  | 'goes-visible'
  | 'goes-airmass'
  | 'goes-dust'
  | 'goes-firetemp'
  | 'iem-wv-upper'
  | 'iem-wv-mid'
  | 'iem-wv-lower';
export type SatSourceId = 'lwxr' | GoesSourceId;
export type GoesLegend = 'ir' | 'wv' | 'rgb';
export type SatProvider = 'gibs' | 'iem';
export const GOES_SOURCES: Record<GoesSourceId, {
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
export const satTileUrl = (cfg: typeof GOES_SOURCES[GoesSourceId], cacheKey: number) =>
  cfg.provider === 'iem'
    ? `${IEM_BASE}/${cfg.layer}/{z}/{x}/{y}.png?_t=${cacheKey}`
    : `${GIBS_BASE}/${cfg.layer}/default/default/${cfg.matrix}/{z}/{y}/{x}.png?_t=${cacheKey}`;

// Default fly-to when the operator first switches from CONUS → single site
// (and no site has been chosen yet). KNQA = Memphis, the home office.
export const DEFAULT_SITE_CODE = 'KNQA';
