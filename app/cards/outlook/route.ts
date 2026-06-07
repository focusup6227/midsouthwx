// Public severe-weather outlook graphic (Facebook 4:5 PNG): SPC Day-1
// categorical risk + active warning outlines over a Mid-South Mapbox basemap.
// Edge runtime; reads SPC + alerts with the service role (both are public NWS
// products, no subscriber data). ?download=1 forces an attachment download.

import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { outlookCardElement, type OverlayPath, type OutlookCardData } from '@/lib/social/outlook-card';
import { loadCardFonts } from '@/lib/social/og-fonts';
import { planViewport, makeProjector, geometryToPath, bboxOverlapsGeometry, type Bbox } from '@/lib/social/geo';

export const runtime = 'edge';

const WIDTH = 1080;
const HEIGHT = 1350;
const HERO_W = 1080;
const HERO_H = 700;
// Mid-South area of responsibility: roughly the Memphis CWA plus neighbors.
const AOR_BBOX: Bbox = [-94.3, 32.2, -84.6, 38.6];

type Cat = 'TSTM' | 'MRGL' | 'SLGT' | 'ENH' | 'MDT' | 'HIGH';
const CAT_RANK: Record<Cat, number> = { TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
const CAT_FILL: Record<Cat, { fill: string; stroke: string }> = {
  TSTM: { fill: 'rgba(193,233,193,0.28)', stroke: '#7cc47c' },
  MRGL: { fill: 'rgba(102,163,102,0.32)', stroke: '#66a366' },
  SLGT: { fill: 'rgba(255,224,102,0.32)', stroke: '#e6c84d' },
  ENH: { fill: 'rgba(255,150,80,0.34)', stroke: '#ff9650' },
  MDT: { fill: 'rgba(230,114,114,0.40)', stroke: '#e67272' },
  HIGH: { fill: 'rgba(238,130,238,0.42)', stroke: '#ee82ee' },
};
const RISK_DISPLAY: Record<Cat, { label: string; color: string }> = {
  TSTM: { label: 'General Thunderstorms', color: '#4ade80' },
  MRGL: { label: 'Marginal Risk', color: '#22c55e' },
  SLGT: { label: 'Slight Risk', color: '#eab308' },
  ENH: { label: 'Enhanced Risk', color: '#f97316' },
  MDT: { label: 'Moderate Risk', color: '#ef4444' },
  HIGH: { label: 'High Risk', color: '#d946ef' },
};

function fmt(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function asCat(v: unknown): Cat | null {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return (s in CAT_RANK ? (s as Cat) : null);
}

export async function GET(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // SPC Day 1 outlook.
  const { data: spc } = await supabase
    .from('spc_outlooks')
    .select('geojson, highest_label, valid_from, valid_until, issued_at')
    .eq('day_number', 1)
    .maybeSingle();

  // Active warnings/watches (public NWS alerts).
  const { data: alertsFc } = await supabase.rpc('nws_alerts_radar_geojson');

  const vp = planViewport(AOR_BBOX, HERO_W, HERO_H);
  const project = makeProjector(vp, HERO_W, HERO_H);
  const paths: OverlayPath[] = [];

  // SPC categorical polygons, painted low → high so the worst risk sits on top.
  type Feat = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, Record<string, unknown>>;
  const spcFeatures: Feat[] = (((spc?.geojson as GeoJSON.FeatureCollection | undefined)?.features ?? []) as Feat[])
    .filter((f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
  spcFeatures
    .map((f) => ({ f, cat: asCat(f.properties?.LABEL ?? f.properties?.label) }))
    .filter((x): x is { f: Feat; cat: Cat } => x.cat !== null)
    .sort((a, b) => CAT_RANK[a.cat] - CAT_RANK[b.cat])
    .forEach(({ f, cat }) => {
      const c = CAT_FILL[cat];
      paths.push({ d: geometryToPath(f.geometry, project), fill: c.fill, stroke: c.stroke, strokeWidth: 2.5 });
    });

  // Active warning outlines on top + counts for the summary line.
  let tornadoWarn = 0;
  let severeWarn = 0;
  let watches = 0;
  const warnFeatures = (((alertsFc as GeoJSON.FeatureCollection | undefined)?.features ?? []) as Feat[]).filter(
    (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
  );
  for (const f of warnFeatures) {
    const event = String(f.properties?.event ?? '').toLowerCase();
    const isWarning = event.includes('warning');
    const isWatch = event.includes('watch');
    if (isWatch) watches += 1;
    if (isWarning && event.includes('tornado')) {
      tornadoWarn += 1;
      paths.push({ d: geometryToPath(f.geometry, project), fill: 'rgba(220,38,38,0.12)', stroke: '#fecaca', strokeWidth: 3 });
    } else if (isWarning && event.includes('thunderstorm')) {
      severeWarn += 1;
      paths.push({ d: geometryToPath(f.geometry, project), fill: 'rgba(234,88,12,0.10)', stroke: '#fed7aa', strokeWidth: 3 });
    }
  }

  // Headline the highest risk that actually covers the Mid-South area we frame —
  // NOT spc.highest_label, which is the worst band anywhere in the national
  // outlook (an ENH in the Plains shouldn't headline a Mid-South SLGT day).
  let highest: Cat | null = null;
  let highestRank = 0;
  for (const f of spcFeatures) {
    const cat = asCat(f.properties?.LABEL ?? f.properties?.label);
    if (!cat || CAT_RANK[cat] <= highestRank) continue;
    if (!bboxOverlapsGeometry(f.geometry, AOR_BBOX)) continue;
    highest = cat;
    highestRank = CAT_RANK[cat];
  }
  const risk = highest ? RISK_DISPLAY[highest] : { label: 'No Severe Outlook', color: '#64748b' };

  let warningSummary: string;
  if (tornadoWarn + severeWarn > 0) {
    const parts: string[] = [];
    if (tornadoWarn) parts.push(`${tornadoWarn} tornado`);
    if (severeWarn) parts.push(`${severeWarn} severe`);
    warningSummary = `${parts.join(' · ')} warning${tornadoWarn + severeWarn > 1 ? 's' : ''} active now`;
  } else if (watches > 0) {
    warningSummary = `${watches} active watch${watches > 1 ? 'es' : ''} in effect`;
  } else {
    warningSummary = 'No active warnings or watches';
  }

  const token = process.env.MAPBOX_STATIC_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const heroUrl = token
    ? `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${vp.centerLng.toFixed(4)},${vp.centerLat.toFixed(4)},${vp.zoom.toFixed(2)}/${HERO_W}x${HERO_H}@2x?access_token=${token}&logo=false&attribution=false`
    : null;

  const validText = spc?.valid_from
    ? `SPC outlook valid through ${fmt(spc.valid_until)} CT`
    : 'SPC Day 1 convective outlook';
  const issuedText = spc?.issued_at ? `Issued ${fmt(spc.issued_at)} CT by NOAA/SPC` : null;

  const cardData: OutlookCardData = {
    heroUrl,
    heroW: HERO_W,
    heroH: HERO_H,
    paths,
    riskLabel: risk.label,
    riskColor: risk.color,
    validText,
    warningSummary,
    issuedText,
  };

  const res = new ImageResponse(outlookCardElement(cardData), {
    width: WIDTH,
    height: HEIGHT,
    fonts: await loadCardFonts(),
  });

  if (new URL(req.url).searchParams.has('download')) {
    res.headers.set('Content-Disposition', 'attachment; filename="midsouthwx-severe-outlook.png"');
  }
  res.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
  return res;
}
