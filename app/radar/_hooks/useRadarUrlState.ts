'use client';

import { useEffect, useRef } from 'react';

// Radar state we round-trip through URL params so a /radar URL is shareable
// and survives refresh. Kept small on purpose — the more we encode, the longer
// the URL and the more brittle the parser. Per-category alert toggles and
// other rarely-changed bits are intentionally NOT here.
export type RadarUrlState = {
  site: string | null;          // NEXRAD code, e.g. KNQA
  product: string;              // 'composite' | 'reflectivity' | 'velocity' | 'correlation' | 'rotation' | 'satellite'
  hiRes: boolean;
  opacity: number;              // 20..100
  showNws: boolean;
  showSpc: boolean;
  showLsr: boolean;
  showZones: boolean;
  showSubs: boolean;
  showStormTracks: boolean;
  showArrows: boolean;          // LibreWxR storm-motion arrow overlay
  colorScheme: number;          // LibreWxR color scheme 1..9 (8 = NWS Reflectivity)
  satSource: string;            // 'lwxr' (default, animated) or a GOES-East GIBS band id
  showCap: boolean;             // LibreWxR CAP alert polygons overlay
  inspectorCollapsed: boolean;  // Right inspector collapsed to thin rail
  uiHidden: boolean;            // Hide all map chrome except timeline + hide button
  showSitePills: boolean;       // NEXRAD geographic site pills overlay
  showLightning: boolean;       // GOES-19 GLM lightning flashes overlay
  showCouplets: boolean;        // F9: NEXRAD velocity-couplet rotation IDs
  showMesh: boolean;            // F10: MRMS MESH (Max Estimated Size of Hail) overlay
  meshWindow: 30 | 60 | 120;    // F10: MESH accumulation window in minutes
  showMetar: boolean;           // F12: METAR surface obs overlay
  showMping: boolean;           // F13: mPING crowdsource reports overlay
};

const KEY_MAP = {
  site:               's',
  product:            'p',
  hiRes:              'hr',
  opacity:            'o',
  showNws:            'nws',
  showSpc:            'spc',
  showLsr:            'lsr',
  showZones:          'z',
  showSubs:           'sub',
  showStormTracks:    'tr',
  showArrows:         'arr',
  colorScheme:        'cs',
  satSource:          'sat',
  showCap:            'cap',
  inspectorCollapsed: 'ic',
  uiHidden:           'hide',
  showSitePills:      'pills',
  showLightning:      'ltg',
  showCouplets:       'cpl',
  showMesh:           'mesh',
  meshWindow:         'mwin',
  showMetar:          'mtr',
  showMping:          'mpg',
} as const satisfies Record<keyof RadarUrlState, string>;

const VALID_PRODUCTS = new Set(['composite', 'reflectivity', 'velocity', 'correlation', 'rotation', 'satellite']);
const VALID_SAT_SOURCES = new Set([
  'lwxr', 'goes-cleanir', 'goes-geocolor', 'goes-visible', 'goes-airmass', 'goes-dust', 'goes-firetemp',
]);

export function parseRadarUrl(search: string): Partial<RadarUrlState> {
  const sp = new URLSearchParams(search);
  const out: Partial<RadarUrlState> = {};
  const site = sp.get(KEY_MAP.site);
  if (site && /^[A-Z]{4}$/.test(site)) out.site = site;
  const product = sp.get(KEY_MAP.product);
  if (product && VALID_PRODUCTS.has(product)) out.product = product;
  const hr = sp.get(KEY_MAP.hiRes);
  if (hr === '1' || hr === '0') out.hiRes = hr === '1';
  const op = sp.get(KEY_MAP.opacity);
  if (op != null) {
    const n = Number(op);
    if (Number.isFinite(n) && n >= 20 && n <= 100) out.opacity = Math.round(n);
  }
  const flags: (keyof RadarUrlState)[] = [
    'showNws', 'showSpc', 'showLsr', 'showZones', 'showSubs', 'showStormTracks', 'showArrows', 'showCap',
    'inspectorCollapsed', 'uiHidden', 'showSitePills', 'showLightning', 'showCouplets', 'showMesh', 'showMetar', 'showMping',
  ];
  for (const k of flags) {
    const v = sp.get(KEY_MAP[k]);
    if (v === '1' || v === '0') (out as Record<string, unknown>)[k] = v === '1';
  }
  const cs = sp.get(KEY_MAP.colorScheme);
  if (cs != null) {
    const n = Number(cs);
    if (Number.isInteger(n) && n >= 1 && n <= 9) out.colorScheme = n;
  }
  const sat = sp.get(KEY_MAP.satSource);
  if (sat && VALID_SAT_SOURCES.has(sat)) out.satSource = sat;
  const mwin = sp.get(KEY_MAP.meshWindow);
  if (mwin === '30' || mwin === '60' || mwin === '120') {
    out.meshWindow = parseInt(mwin, 10) as 30 | 60 | 120;
  }
  return out;
}

// Watches the given state and writes it back to the URL via replaceState so
// the browser back button isn't polluted. Skips the very first render so
// initial state from URL doesn't immediately re-encode (avoids churn).
export function useRadarUrlSync(state: RadarUrlState) {
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);

    const setOrDelete = (key: string, value: string | null) => {
      if (value == null) sp.delete(key);
      else sp.set(key, value);
    };

    setOrDelete(KEY_MAP.site, state.site);
    setOrDelete(KEY_MAP.product, state.product === 'composite' ? null : state.product);
    setOrDelete(KEY_MAP.hiRes, state.hiRes ? null : '0');
    setOrDelete(KEY_MAP.opacity, state.opacity === 78 ? null : String(state.opacity));
    setOrDelete(KEY_MAP.showNws, state.showNws ? null : '0');
    setOrDelete(KEY_MAP.showSpc, state.showSpc ? '1' : null);
    setOrDelete(KEY_MAP.showLsr, state.showLsr ? null : '0');
    setOrDelete(KEY_MAP.showZones, state.showZones ? '1' : null);
    setOrDelete(KEY_MAP.showSubs, state.showSubs ? null : '0');
    setOrDelete(KEY_MAP.showStormTracks, state.showStormTracks ? null : '0');
    setOrDelete(KEY_MAP.showArrows, state.showArrows ? null : '0');
    setOrDelete(KEY_MAP.colorScheme, state.colorScheme === 8 ? null : String(state.colorScheme));
    setOrDelete(KEY_MAP.satSource, state.satSource === 'lwxr' ? null : state.satSource);
    setOrDelete(KEY_MAP.showCap, state.showCap ? '1' : null);
    setOrDelete(KEY_MAP.inspectorCollapsed, state.inspectorCollapsed ? '1' : null);
    setOrDelete(KEY_MAP.uiHidden, state.uiHidden ? '1' : null);
    setOrDelete(KEY_MAP.showSitePills, state.showSitePills ? null : '0');
    setOrDelete(KEY_MAP.showLightning, state.showLightning ? '1' : null);
    setOrDelete(KEY_MAP.showCouplets, state.showCouplets ? '1' : null);
    setOrDelete(KEY_MAP.showMesh, state.showMesh ? '1' : null);
    setOrDelete(KEY_MAP.meshWindow, state.meshWindow === 30 ? null : String(state.meshWindow));
    setOrDelete(KEY_MAP.showMetar, state.showMetar ? '1' : null);
    setOrDelete(KEY_MAP.showMping, state.showMping ? '1' : null);

    const qs = sp.toString();
    const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', next);
  }, [
    state.site,
    state.product,
    state.hiRes,
    state.opacity,
    state.showNws,
    state.showSpc,
    state.showLsr,
    state.showZones,
    state.showSubs,
    state.showStormTracks,
    state.showArrows,
    state.colorScheme,
    state.satSource,
    state.showCap,
    state.inspectorCollapsed,
    state.uiHidden,
    state.showSitePills,
    state.showLightning,
    state.showCouplets,
    state.showMesh,
    state.meshWindow,
    state.showMetar,
    state.showMping,
  ]);
}
