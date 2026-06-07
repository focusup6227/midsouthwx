// Public, token-gated forecast graphic for social sharing (Facebook 4:5
// portrait PNG). Operators hit this with ?download=1 from the forecast page to
// grab a high-res image to post natively; it also doubles as the og:image for
// /f/[token] so a pasted link renders a rich preview. Service-role read mirrors
// the access control on app/f/[token]/page.tsx (public_token + issued/closed),
// so no operator session is required. Edge runtime so the bundled .woff fonts
// resolve via import.meta.url and Satori renders crisp branded type.

import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { forecastCardElement, type ForecastCardData } from '@/lib/social/forecast-card';
import { loadCardFonts } from '@/lib/social/og-fonts';

export const runtime = 'edge';

const WIDTH = 1080;
const HEIGHT = 1350;

/** Center of a (Multi)Polygon's bounding box — good enough to reverse-geocode. */
function bboxCenter(geo: any): [number, number] | null {
  const coords = geo?.coordinates;
  if (!Array.isArray(coords)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
  for (const poly of coords) {
    const ring = poly?.[0];
    if (!Array.isArray(ring)) continue;
    for (const pt of ring) {
      const [x, y] = pt;
      if (typeof x === 'number' && typeof y === 'number') {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return found ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

/** Reverse-geocode a point to a "County, ST" label (prefers county, then city). */
async function reverseGeocode(lon: number, lat: number, token: string): Promise<string | null> {
  try {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json` +
      `?types=district,place,region&limit=1&access_token=${token}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const feat = (await res.json())?.features?.[0];
    if (!feat) return null;
    const by: Record<string, any> = {};
    const add = (f: any) => {
      const t = String(f?.id ?? '').split('.')[0];
      if (t && !by[t]) by[t] = f;
    };
    add(feat);
    for (const c of feat.context ?? []) add(c);
    const region = by.region;
    const st = region?.short_code
      ? String(region.short_code).replace(/^US-/i, '').toUpperCase()
      : region?.text ?? '';
    const name: string | null = by.district?.text ?? by.place?.text ?? region?.text ?? null;
    if (!name) return null;
    return st && name !== region?.text ? `${name}, ${st}` : name;
  } catch {
    return null;
  }
}

export async function GET(req: Request, { params }: { params: { token: string } }) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // The secret public_token is the access gate. Unlike the public page (which
  // only shows issued/closed forecasts), the graphic renders at any stage so
  // operators can preview/download before broadcasting — a draft with a share
  // link should not 404 the Download button.
  const [{ data }, { data: areaGeo }] = await Promise.all([
    supabase
      .from('forecasts')
      .select('title, hazards, confidence, status, valid_from, valid_until, discussion, verification')
      .eq('public_token', params.token)
      .maybeSingle(),
    supabase.rpc('forecast_public_area_geojson', { p_token: params.token }),
  ]);

  if (!data) {
    return new Response('Not found', { status: 404 });
  }

  // Reverse-geocode the area centroid so the card says *where* it applies.
  const mapboxToken = process.env.MAPBOX_STATIC_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const center = bboxCenter(areaGeo);
  const areaLabel =
    center && mapboxToken ? await reverseGeocode(center[0], center[1], mapboxToken) : null;

  const cardData: ForecastCardData = {
    title: data.title,
    areaLabel,
    hazards: Array.isArray(data.hazards) ? (data.hazards as string[]) : [],
    confidence: data.confidence,
    status: data.status,
    validFrom: data.valid_from,
    validUntil: data.valid_until,
    discussion: data.discussion,
    verification: (data.verification as ForecastCardData['verification']) ?? null,
  };

  const res = new ImageResponse(forecastCardElement(cardData), {
    width: WIDTH,
    height: HEIGHT,
    fonts: await loadCardFonts(),
  });

  if (new URL(req.url).searchParams.has('download')) {
    const slug =
      (data.title || 'forecast')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 60) || 'forecast';
    res.headers.set('Content-Disposition', `attachment; filename="midsouthwx-${slug}.png"`);
  }
  // Forecasts can be edited/closed, so cache briefly at the edge but allow
  // long stale-while-revalidate to keep Facebook's scraper fast.
  res.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  return res;
}
