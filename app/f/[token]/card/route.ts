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

export async function GET(req: Request, { params }: { params: { token: string } }) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data } = await supabase
    .from('forecasts')
    .select('title, hazards, confidence, status, valid_from, valid_until, discussion, verification')
    .eq('public_token', params.token)
    .in('status', ['issued', 'closed'])
    .maybeSingle();

  if (!data) {
    return new Response('Not found', { status: 404 });
  }

  const cardData: ForecastCardData = {
    title: data.title,
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
