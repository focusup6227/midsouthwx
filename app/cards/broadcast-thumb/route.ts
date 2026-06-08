// YouTube broadcast thumbnail (16:9 1280×720 PNG): SPC Day-1 categorical risk +
// active warning outlines over a Mid-South Mapbox basemap, with a big operator-
// supplied headline. Edge runtime; reads public SPC + alerts with the service
// role (public NWS products, no subscriber data). Public via /cards/.
//   ?headline=SEVERE RISK FRIDAY   (defaults to the computed risk label)
//   ?download=1                    (force attachment)

import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { thumbnailCardElement, type ThumbCardData } from '@/lib/social/thumbnail-card';
import type { OverlayPath } from '@/lib/social/outlook-card';
import { loadCardFonts } from '@/lib/social/og-fonts';
import { planViewport, makeProjector, geometryToPath, type Bbox } from '@/lib/social/geo';

export const runtime = 'edge';

const WIDTH = 1280;
const HEIGHT = 720;
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
  TSTM: { label: 'Thunderstorms', color: '#4ade80' },
  MRGL: { label: 'Marginal', color: '#22c55e' },
  SLGT: { label: 'Slight Risk', color: '#eab308' },
  ENH: { label: 'Enhanced', color: '#f97316' },
  MDT: { label: 'Moderate', color: '#ef4444' },
  HIGH: { label: 'High Risk', color: '#d946ef' },
};

function asCat(v: unknown): Cat | null {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return s in CAT_RANK ? (s as Cat) : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: spc } = await supabase
    .from('spc_outlooks')
    .select('geojson, highest_label')
    .eq('day_number', 1)
    .maybeSingle();

  const { data: alertsFc } = await supabase.rpc('nws_alerts_radar_geojson');

  const vp = planViewport(AOR_BBOX, WIDTH, HEIGHT);
  const project = makeProjector(vp, WIDTH, HEIGHT);
  const paths: OverlayPath[] = [];

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

  const warnFeatures = (((alertsFc as GeoJSON.FeatureCollection | undefined)?.features ?? []) as Feat[]).filter(
    (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
  );
  for (const f of warnFeatures) {
    const event = String(f.properties?.event ?? '').toLowerCase();
    if (event.includes('warning') && event.includes('tornado')) {
      paths.push({ d: geometryToPath(f.geometry, project), fill: 'rgba(220,38,38,0.14)', stroke: '#fecaca', strokeWidth: 3 });
    } else if (event.includes('warning') && event.includes('thunderstorm')) {
      paths.push({ d: geometryToPath(f.geometry, project), fill: 'rgba(234,88,12,0.12)', stroke: '#fed7aa', strokeWidth: 3 });
    }
  }

  const highest = asCat(spc?.highest_label);
  const risk = highest ? RISK_DISPLAY[highest] : { label: 'Quiet', color: '#64748b' };

  const headline =
    (url.searchParams.get('headline') || '').trim() ||
    (highest ? `${risk.label.toUpperCase()} TODAY` : 'WEATHER BRIEFING');

  const dateText = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  const token = process.env.MAPBOX_STATIC_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const heroUrl = token
    ? `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${vp.centerLng.toFixed(4)},${vp.centerLat.toFixed(4)},${vp.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}&logo=false&attribution=false`
    : null;

  const cardData: ThumbCardData = {
    heroUrl,
    heroW: WIDTH,
    heroH: HEIGHT,
    paths,
    headline,
    riskLabel: risk.label,
    riskColor: risk.color,
    dateText,
    brand: 'Mid-South WX',
  };

  const res = new ImageResponse(thumbnailCardElement(cardData), {
    width: WIDTH,
    height: HEIGHT,
    fonts: await loadCardFonts(),
  });

  if (url.searchParams.has('download')) {
    res.headers.set('Content-Disposition', 'attachment; filename="midsouthwx-thumbnail.png"');
  }
  res.headers.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  return res;
}
