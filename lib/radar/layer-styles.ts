// Mapbox paint/layout expressions and color palettes for the radar map.
// Extracted from app/radar/RadarView.tsx so other map surfaces (AlertMap,
// CheckinMap) can share the same palette instead of duplicating hex values.

// Baron256 reflectivity palette (~/Downloads/Baron256.pal). Each pair of
// (val, color) stops below is a *boundary* between Baron's hardcoded gradient
// bands — the e.g. 14.99/15 pair forces a hard color jump from the end of one
// band (light blue) to the start of the next (light green), matching how
// Baron's display steps colors at every 5 dBZ band.
export const REFL_STOPS: [number, string][] = [
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
export const VEL_STOPS: [number, string][] = [
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
export const CC_STOPS: [number, string][] = [
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

// ZDR is rendered via the PNG path (useL2Png), so these GeoJSON paint helpers
// never actually run for 'zdr' — the union just keeps the types aligned with
// level2Product. (ZDR falls through to the CC stops here but is unreachable.)
export function buildFillColorExpr(product: 'refl' | 'vel' | 'srm' | 'sw' | 'cc' | 'zdr' | 'kdp', _vmin: number, _vmax: number): any {
  // The renderer stores raw values in properties.v (dBZ for refl, m/s for vel,
  // dimensionless for cc), so the interpolate stops compare against raw scale
  // too. (Earlier code normalized to a 0–255 byte scale to match the original
  // PNG renderer's quantization — no longer applicable now that we use
  // GeoJSON polygons with real values.)
  const stops = product === 'refl' ? REFL_STOPS : product === 'vel' || product === 'srm' ? VEL_STOPS : CC_STOPS;
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

export function buildFillOpacityExpr(product: 'refl' | 'vel' | 'srm' | 'sw' | 'cc' | 'zdr' | 'kdp', userOpacity: number,
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

// Stable paint objects for the selection / draw layers — these never change,
// so hoisting them out of render eliminates a fresh paint diff on every render.
export const SEL_POLY_FILL_PAINT: any = { 'fill-color': '#fbbf24', 'fill-opacity': 0.12 };
export const SEL_POLY_LINE_PAINT: any = { 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [2, 1] };

// F7: SPC categorical-outlook palette. The convention (and SPC's own map)
// goes light-green → green → yellow → orange → red → magenta as risk
// escalates from general thunderstorms to a HIGH risk day. Each feature's
// `properties.LABEL` is the short code (TSTM / MRGL / SLGT / ENH / MDT / HIGH).
export const SPC_FILL_EXPR: any = [
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
export const SPC_LINE_EXPR: any = [
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
export const LSR_FILL_EXPR: any = [
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

// Subscriber storm reports use a slightly different hazard taxonomy
// (funnel/hail/other are distinct, mirroring the Telegram picker labels).
export const STORM_REPORT_FILL_EXPR: any = [
  'match',
  ['get', 'hazard'],
  'tornado', '#ef4444',
  'funnel',  '#fb7185',
  'hail',    '#f97316',
  'wind',    '#a855f7',
  'flood',   '#10b981',
  '#94a3b8',
];

// All LibreWxR frame layers mount opacity 0. The "current" frame is bumped
// up imperatively in the playback effect; reusing this single paint object
// across all 30+ frames means react-map-gl doesn't diff a new paint every
// tick. 'linear' resampling smooths the over-scaled tiles past z7 instead of
// showing crunchy nearest-neighbor squares.
export const LWXR_FRAME_PAINT: any = {
  'raster-opacity': 0,
  'raster-fade-duration': 0,
  'raster-resampling': 'linear',
  // LibreWxR composite tiles are pretty dim out of the box. Saturate +
  // contrast so the green/yellow/red reads as bright as observed radar.
  'raster-saturation': 0.35,
  'raster-contrast': 0.2,
};

export const WARNING_FILL_EXPR: any = [
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
  // Watches tinted by concern type: tornado watch reads red, severe watch
  // amber, anything else the legacy yellow.
  ['all', ['==', ['get', 'category'], 'watch'], ['==', ['get', 'concern_type'], 'tornado']],
  'rgba(239,68,68,0.15)',
  ['all', ['==', ['get', 'category'], 'watch'], ['==', ['get', 'concern_type'], 'severe']],
  'rgba(245,158,11,0.13)',
  ['==', ['get', 'category'], 'watch'],
  'rgba(250,204,21,0.10)',
  ['==', ['get', 'category'], 'advisory'],
  'rgba(167,139,250,0.16)',
  // Mesoscale Discussions tinted by CONCERN TYPE (what they're about, parsed
  // from the discussion body) so a tornado MD reads red, winter indigo, fire
  // orange, flood green — not just one fuchsia blob.
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'tornado']],
  'rgba(239,68,68,0.24)',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'severe']],
  'rgba(245,158,11,0.20)',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'flood']],
  'rgba(16,185,129,0.20)',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'winter']],
  'rgba(129,140,248,0.20)',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'fire']],
  'rgba(251,146,60,0.20)',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'wind']],
  'rgba(56,189,248,0.18)',
  ['==', ['get', 'category'], 'discussion'],
  'rgba(217,70,239,0.18)',
  // Statements (incl. Special Weather Statements for hail) at higher opacity
  // than before — they used to nearly disappear over bright radar pixels.
  ['==', ['get', 'category'], 'statement'],
  'rgba(148,163,184,0.22)',
  'rgba(148,163,184,0.12)',
];

export const WARNING_LINE_EXPR: any = [
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
  ['all', ['==', ['get', 'category'], 'watch'], ['==', ['get', 'concern_type'], 'tornado']],
  '#ef4444',
  ['all', ['==', ['get', 'category'], 'watch'], ['==', ['get', 'concern_type'], 'severe']],
  '#f59e0b',
  ['==', ['get', 'category'], 'watch'],
  '#eab308',
  ['==', ['get', 'category'], 'advisory'],
  '#a78bfa',
  // MD outline keyed to concern type (see CONCERN_COLORS in lib/nws/concern).
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'tornado']],
  '#ef4444',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'severe']],
  '#f59e0b',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'flood']],
  '#10b981',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'winter']],
  '#818cf8',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'fire']],
  '#fb923c',
  ['all', ['==', ['get', 'category'], 'discussion'], ['==', ['get', 'concern_type'], 'wind']],
  '#38bdf8',
  ['==', ['get', 'category'], 'discussion'],
  '#d946ef',
  ['==', ['get', 'category'], 'statement'],
  '#94a3b8',
  '#64748b',
];

// Stable paint objects for the warning fill + line layers. selectedWarning
// drives line-width imperatively via setPaintProperty in an effect so
// react-map-gl doesn't re-diff the whole paint object every time a different
// warning is clicked.
export const WARNING_FILL_PAINT: any = {
  'fill-color': WARNING_FILL_EXPR,
  'fill-opacity': 0.9,
};
export const WARNING_LINE_PAINT: any = {
  'line-color': WARNING_LINE_EXPR,
  'line-width': 2,
  'line-opacity': 0.9,
};
export const WARNING_LINE_WATCH_PAINT: any = {
  'line-color': WARNING_LINE_EXPR,
  'line-width': 2,
  'line-opacity': 0.85,
  'line-dasharray': [2, 1.5],
};
// SPC Mesoscale Discussions: longer dash with smaller gap so MCDs read as
// "concern outlook" outline rather than an active warning. Fuchsia hue comes
// from WARNING_LINE_EXPR's discussion branch.
export const WARNING_LINE_DISCUSSION_PAINT: any = {
  'line-color': WARNING_LINE_EXPR,
  'line-width': 1.8,
  'line-opacity': 0.9,
  'line-dasharray': [4, 2],
};
