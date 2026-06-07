// Public daily forecast graphic (Facebook 4:5 PNG) for a point. Defaults to
// the Mid-South hub (Memphis); pass ?lat=&lon=&place= to retarget. Pulls NWS
// named periods (Today/Tonight/…) at request time. Edge runtime; no DB needed.
// ?download=1 forces an attachment download.

import { ImageResponse } from 'next/og';
import { dailyCardElement, type DailyCardData, type DailyPeriod } from '@/lib/social/daily-card';
import { loadCardFonts } from '@/lib/social/og-fonts';

export const runtime = 'edge';

const WIDTH = 1080;
const HEIGHT = 1350;
const DEFAULT = { lat: 35.1495, lon: -90.049, place: 'Memphis, TN' };

const UA = () => process.env.NWS_USER_AGENT || 'midsouthwx (contact: operator@midsouthwx)';

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA(), Accept: 'application/geo+json, application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ABBR: Record<string, string> = {
  Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat',
};
function shortName(name: string): string {
  let n = name;
  for (const wd of WEEKDAYS) n = n.replace(wd, ABBR[wd]);
  return n;
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  // Note: absent params return null, and Number(null) === 0 (not NaN), so guard
  // on presence before parsing or "no params" would resolve to lat/lon 0,0.
  const latRaw = sp.get('lat');
  const lonRaw = sp.get('lon');
  const lat = latRaw != null ? Number(latRaw) : NaN;
  const lon = lonRaw != null ? Number(lonRaw) : NaN;
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
  const qLat = hasPoint ? lat : DEFAULT.lat;
  const qLon = hasPoint ? lon : DEFAULT.lon;

  const pt = await getJson(`https://api.weather.gov/points/${qLat.toFixed(4)},${qLon.toFixed(4)}`);
  const rel = pt?.properties?.relativeLocation?.properties;
  const place =
    sp.get('place') ||
    (rel?.city && rel?.state ? `${rel.city}, ${rel.state}` : hasPoint ? `${qLat.toFixed(2)}, ${qLon.toFixed(2)}` : DEFAULT.place);

  const fcUrl: string | undefined = pt?.properties?.forecast;
  const fc = fcUrl ? await getJson(fcUrl) : null;
  const rawPeriods: any[] = Array.isArray(fc?.properties?.periods) ? fc.properties.periods : [];

  const periods: DailyPeriod[] = rawPeriods.slice(0, 5).map((p) => ({
    name: shortName(String(p.name ?? '')),
    temp: typeof p.temperature === 'number' ? p.temperature : null,
    unit: String(p.temperatureUnit ?? 'F'),
    isDay: Boolean(p.isDaytime),
    shortForecast: trunc(String(p.shortForecast ?? ''), 42),
    windText: `${p.windDirection ?? ''} ${p.windSpeed ?? ''}`.trim() || '—',
    popText:
      p.probabilityOfPrecipitation?.value != null
        ? `${p.probabilityOfPrecipitation.value}% precip`
        : 'no precip',
    iconUrl: p.icon ? String(p.icon).replace(/size=\w+/, 'size=medium') : null,
  }));

  let updatedText: string | null = null;
  if (fc?.properties?.updated) {
    try {
      updatedText = `Updated ${new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(fc.properties.updated))} CT`;
    } catch {
      updatedText = null;
    }
  }

  const cardData: DailyCardData = { place, updatedText, periods };

  const res = new ImageResponse(dailyCardElement(cardData), {
    width: WIDTH,
    height: HEIGHT,
    fonts: await loadCardFonts(),
  });

  if (sp.has('download')) {
    const slug = place.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50) || 'forecast';
    res.headers.set('Content-Disposition', `attachment; filename="midsouthwx-daily-${slug}.png"`);
  }
  res.headers.set('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
  return res;
}
