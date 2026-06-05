import { NextRequest, NextResponse } from 'next/server';
import { OPEN_METEO_ENSEMBLE_BASE, openMeteoKeyParam } from '@/lib/forecast/open-meteo';

export const dynamic = 'force-dynamic';

// GEFS ensemble plumes at a point via the Open-Meteo Ensemble API (free tier;
// paid-ready via the OPEN_METEO_* env seam). Returns, per variable, every
// member's series (control + 30) thinned to 3-hourly, so the EnsemblePlumePanel
// can draw plumes + mean + spread client-side without heavy GRIB plumbing.

const VARS = [
  { key: 'temperature_2m', om: 'temperature_2m' },
  { key: 'dewpoint_2m', om: 'dewpoint_2m' },
  { key: 'precipitation', om: 'precipitation' },
  { key: 'wind_speed_10m', om: 'wind_speed_10m' },
];
const STRIDE = 3; // hourly → 3-hourly for legible plumes

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const lat = Number(sp.get('lat'));
  const lon = Number(sp.get('lon'));
  const days = Math.min(Math.max(Number(sp.get('days')) || 7, 2), 16);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: 'lat and lon required' }, { status: 400 });
  }

  const hourly = VARS.map((v) => v.om).join(',');
  const url =
    `${OPEN_METEO_ENSEMBLE_BASE}/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&hourly=${hourly}&models=gfs025&forecast_days=${days}` +
    `&temperature_unit=fahrenheit&wind_speed_unit=kn&precipitation_unit=inch&timezone=UTC` +
    openMeteoKeyParam();

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    if (!res.ok) {
      return NextResponse.json({ error: `ensemble_${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    const h = data?.hourly;
    if (!h?.time?.length) return NextResponse.json({ error: 'no_data' }, { status: 502 });

    const idx: number[] = [];
    for (let i = 0; i < h.time.length; i += STRIDE) idx.push(i);
    const time = idx.map((i) => `${h.time[i]}Z`);

    const series: Record<string, number[][]> = {};
    for (const v of VARS) {
      // Collect control + member01..N for this variable.
      const memberKeys = Object.keys(h).filter(
        (k) => k === v.om || k.startsWith(`${v.om}_member`),
      );
      series[v.key] = memberKeys.map((k) => idx.map((i) => {
        const val = h[k][i];
        return typeof val === 'number' ? val : NaN;
      }));
    }

    return NextResponse.json(
      { time, series, units: data.hourly_units, members: series[VARS[0].key]?.length ?? 0 },
      { headers: { 'Cache-Control': 'public, s-maxage=1800, max-age=600, stale-while-revalidate=3600' } },
    );
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'fetch_error' }, { status: 502 });
  }
}
