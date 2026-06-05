// Point forecast for the /forecast/data meteogram panel.
//
// Resolves lat/lon → NWS gridpoint → hourly NDFD forecast + nearest surface
// observation, in the fewest round-trips that still degrade gracefully:
//   1. /points/{lat},{lon}        → office, hourly URL, station list, city label
//   2. parallel: hourly forecast  +  observation-stations list
//   3. latest obs for the first station (best-effort; never fails the response)
//
// Follows the repo route-handler convention: force-dynamic, NWS_USER_AGENT,
// AbortSignal timeouts, and always returns 200 with an `error` string rather
// than throwing, so the client can show a soft failure state.

import { NextResponse } from 'next/server';
import { cToF, type HourPoint, type PointForecast } from '@/lib/forecast/points';

export const dynamic = 'force-dynamic';

const UA = () => process.env.NWS_USER_AGENT || 'midsouthwx (contact: operator@midsouthwx)';
const HDRS = () => ({ 'User-Agent': UA(), Accept: 'application/geo+json, application/json' });

const KMH_TO_KT = 0.539957;

async function getJson(url: string, timeoutMs = 10_000): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: HDRS(),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

// NWS hourly windDirection is a cardinal string; convert here so the wire
// payload is already numeric degrees (keeps the client lib import-light).
const CARD: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
function cardDeg(c: string | null | undefined): number | null {
  return c ? (CARD[c.toUpperCase()] ?? null) : null;
}
function windMph(s: string | null | undefined): number | null {
  const nums = s?.match(/\d+/g);
  return nums?.length ? Math.max(...nums.map(Number)) : null;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const lat = Number(sp.get('lat'));
  const lon = Number(sp.get('lon'));
  const hours = Math.min(Math.max(Number(sp.get('hours')) || 48, 6), 156);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: 'lat and lon required' } satisfies Partial<PointForecast>, { status: 400 });
  }

  const empty: PointForecast = {
    location: { city: null, state: null, office: null, radarStation: null, timeZone: null, lat, lon },
    updated: null,
    hourly: [],
    obs: null,
  };

  // NWS rejects >4 decimal places on /points.
  const pt = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  if (!pt?.properties) {
    return NextResponse.json({ ...empty, error: 'point_lookup_failed' }, { status: 200 });
  }
  const p = pt.properties;
  const rel = p.relativeLocation?.properties ?? {};

  const [hourlyData, stationsData] = await Promise.all([
    p.forecastHourly ? getJson(p.forecastHourly) : Promise.resolve(null),
    p.observationStations ? getJson(p.observationStations, 8_000) : Promise.resolve(null),
  ]);

  const periods: any[] = hourlyData?.properties?.periods ?? [];
  const hourly: HourPoint[] = periods.slice(0, hours).map((per) => ({
    time: per.startTime,
    tempF: per.temperatureUnit === 'F' ? num(per.temperature) : cToF(num(per.temperature)),
    dewpF: cToF(num(per.dewpoint?.value)),
    rh: num(per.relativeHumidity?.value),
    pop: num(per.probabilityOfPrecipitation?.value),
    windDeg: cardDeg(per.windDirection),
    windMph: windMph(per.windSpeed),
    short: per.shortForecast ?? '',
  }));

  // Best-effort latest observation from the nearest reporting station.
  let obs: PointForecast['obs'] = null;
  const firstStation: string | undefined = stationsData?.features?.[0]?.properties?.stationIdentifier
    ?? stationsData?.observationStations?.[0]?.split('/').pop();
  if (firstStation) {
    const o = await getJson(`https://api.weather.gov/stations/${firstStation}/observations/latest`, 8_000);
    const op = o?.properties;
    if (op) {
      const wsKmh = num(op.windSpeed?.value);
      const wgKmh = num(op.windGust?.value);
      obs = {
        station: firstStation,
        time: op.timestamp ?? null,
        tempF: cToF(num(op.temperature?.value)),
        dewpF: cToF(num(op.dewpoint?.value)),
        windDeg: num(op.windDirection?.value),
        windKt: wsKmh != null ? Math.round(wsKmh * KMH_TO_KT) : null,
        gustKt: wgKmh != null ? Math.round(wgKmh * KMH_TO_KT) : null,
        wx: op.textDescription ?? null,
        raw: op.rawMessage ?? null,
      };
    }
  }

  const out: PointForecast = {
    location: {
      city: rel.city ?? null,
      state: rel.state ?? null,
      office: p.gridId ?? null,
      radarStation: p.radarStation ?? null,
      timeZone: p.timeZone ?? null,
      lat,
      lon,
    },
    updated: hourlyData?.properties?.updateTime ?? null,
    hourly,
    obs,
  };

  return NextResponse.json(out, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' },
  });
}
