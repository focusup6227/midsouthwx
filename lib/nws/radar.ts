/** NWS event classification for radar map styling. */

export type NwsAlertCategory =
  | 'warning'
  | 'watch'
  | 'advisory'
  | 'discussion'
  | 'statement'
  | 'other';

export type NwsHazardKind =
  | 'tornado'
  | 'severe'
  | 'flood'
  | 'winter'
  | 'heat'
  | 'wind'
  | 'other';

export type NwsRadarAlert = {
  id: string;
  nws_id: string;
  category: NwsAlertCategory;
  hazard: NwsHazardKind;
  event: string;
  label: string;
  headline: string | null;
  // F2: AI-generated one-sentence summary populated by nws-poll. Null when
  // not yet summarized or summarizer was unavailable — UI must fall back to
  // headline / truncated description.
  ai_summary: string | null;
  area_desc: string | null;
  severity: string | null;
  expires_at: string | null;
  effective: string | null;
  centroid: [number, number];
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  // F3: forecast track + count of subscribers inside a corridor around it.
  // forecast_track is the bare LineString (no GeoJSON Feature wrapper) so it
  // can flow straight into the resolve_audience track geometry spec or the
  // radar's compose-link builder. Null when the alert has no parsed
  // stormMotion / stormLocation parameters or has zero subscribers in path.
  forecast_track: GeoJSON.LineString | null;
  in_path_count: number | null;
  in_path_corridor_km: number | null;
};

export function classifyNwsEvent(event: string): {
  category: NwsAlertCategory;
  hazard: NwsHazardKind;
} {
  const e = event.toLowerCase();
  let category: NwsAlertCategory = 'other';
  if (e.includes('mesoscale discussion')) category = 'discussion';
  else if (e.includes('warning') || e.includes('emergency')) category = 'warning';
  else if (e.includes('watch')) category = 'watch';
  else if (e.includes('advisory')) category = 'advisory';
  else if (e.includes('statement') || e.includes('outlook')) category = 'statement';

  let hazard: NwsHazardKind = 'other';
  if (e.includes('tornado')) hazard = 'tornado';
  // 'severe thunderstorm' is the canonical phrase, but Special Weather
  // Statements that flag hail/wind without crossing the warning threshold
  // also belong in the severe-convective bucket so they get the right palette.
  else if (e.includes('severe thunderstorm') || e.includes('hail')) hazard = 'severe';
  else if (e.includes('flood') || e.includes('flash flood')) hazard = 'flood';
  else if (
    e.includes('winter') ||
    e.includes('ice') ||
    e.includes('blizzard') ||
    e.includes('freeze')
  ) {
    hazard = 'winter';
  } else if (e.includes('heat')) hazard = 'heat';
  else if (e.includes('wind') || e.includes('gale')) hazard = 'wind';

  return { category, hazard };
}

export function shortNwsLocation(area_desc: string | null): string | null {
  if (!area_desc) return null;
  const counties = area_desc.split(/;|,/).map((s) => s.trim()).filter(Boolean);
  if (counties.length === 0) return null;
  if (counties.length === 1) return counties[0];
  if (counties.length === 2) return `${counties[0]} & ${counties[1]}`;
  return `${counties[0]} +${counties.length - 1}`;
}

export function nwsRadarLabel(event: string, area_desc: string | null): string {
  const where = shortNwsLocation(area_desc);
  return where ? `${event} · ${where}` : event;
}

function ringCentroid(ring: number[][]): [number, number] | null {
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (const [x, y] of ring) {
    sumX += x;
    sumY += y;
    n++;
  }
  if (!n) return null;
  return [sumX / n, sumY / n];
}

export function geometryCentroid(
  g: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [number, number] {
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  const visit = (rings: number[][][]) => {
    const c = ringCentroid(rings[0] ?? []);
    if (c) {
      sumX += c[0];
      sumY += c[1];
      n++;
    }
  };
  if (g.type === 'Polygon') visit(g.coordinates);
  else for (const poly of g.coordinates) visit(poly);
  if (!n) return [-98, 39];
  return [sumX / n, sumY / n];
}

export function categoryBadge(category: NwsAlertCategory): string {
  switch (category) {
    case 'warning':
      return 'WRN';
    case 'watch':
      return 'WCH';
    case 'advisory':
      return 'ADV';
    case 'discussion':
      return 'MD';
    case 'statement':
      return 'STM';
    default:
      return 'NWS';
  }
}

// Tailwind class fragments used by the radar detail-card border + header so
// the panel reads as the same color the polygon paints on the map. Hazard
// trumps category for warnings (a tornado warning is red, not amber).
type Tint = { border: string; text: string; bg: string };

const TINTS: Record<string, Tint> = {
  'warning:tornado': { border: 'border-red-500/60',     text: 'text-red-300',     bg: 'bg-red-500/10' },
  'warning:severe':  { border: 'border-orange-500/60',  text: 'text-orange-300',  bg: 'bg-orange-500/10' },
  'warning:flood':   { border: 'border-emerald-500/60', text: 'text-emerald-300', bg: 'bg-emerald-500/10' },
  'warning:winter':  { border: 'border-sky-500/60',     text: 'text-sky-300',     bg: 'bg-sky-500/10' },
  'warning:*':       { border: 'border-amber-500/60',   text: 'text-amber-300',   bg: 'bg-amber-500/10' },
  'watch:*':         { border: 'border-yellow-500/50',  text: 'text-yellow-200',  bg: 'bg-yellow-500/10' },
  'advisory:*':      { border: 'border-violet-500/50',  text: 'text-violet-200',  bg: 'bg-violet-500/10' },
  'discussion:*':    { border: 'border-fuchsia-500/60', text: 'text-fuchsia-200', bg: 'bg-fuchsia-500/10' },
  'statement:*':     { border: 'border-slate-500/50',   text: 'text-slate-300',   bg: 'bg-slate-500/10' },
  'other:*':         { border: 'border-slate-500/50',   text: 'text-slate-300',   bg: 'bg-slate-500/10' },
};

export function alertTint(category: NwsAlertCategory, hazard: string | null | undefined): Tint {
  const h = hazard ?? '*';
  return TINTS[`${category}:${h}`] ?? TINTS[`${category}:*`] ?? TINTS['other:*'];
}
