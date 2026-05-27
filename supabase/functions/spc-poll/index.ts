// F7: Fetch SPC Day 1/2/3 categorical convective outlooks and upsert into
// spc_outlooks. SPC publishes a fresh Day 1 ~5x/day (1200/1300/1630/2000/0100
// UTC) and Day 2/3 ~1x/day; polling every 30 min comfortably catches them
// without thrashing the endpoint.
//
// The URLs are stable and CORS-open so we *could* hit them straight from
// the browser, but going through the upsert keeps a single source of truth
// for the /radar layer and lets the cron schedule survive client disconnects.

import { serviceClient, json, withHealthLog } from './supabase.ts';

const SPC_URLS: { day: number; url: string }[] = [
  { day: 1, url: 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson' },
  { day: 2, url: 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.lyr.geojson' },
  { day: 3, url: 'https://www.spc.noaa.gov/products/outlook/day3otlk_cat.lyr.geojson' },
];

type FetchResult = { day: number; ok: boolean; features?: number; error?: string };

Deno.serve(withHealthLog('spc-poll', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const ua = Deno.env.get('NWS_USER_AGENT') || 'midsouthwx (contact: operator@midsouthwx)';
  const supa = serviceClient();
  const results: FetchResult[] = [];

  for (const { day, url } of SPC_URLS) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          Accept: 'application/geo+json, application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        results.push({ day, ok: false, error: `HTTP ${res.status}` });
        continue;
      }
      const fc = (await res.json()) as { type?: string; features?: unknown[] };
      if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
        results.push({ day, ok: false, error: 'not a FeatureCollection' });
        continue;
      }
      const { error } = await supa.rpc('spc_outlooks_upsert', {
        p_day_number: day,
        p_geojson: fc as unknown as Record<string, unknown>,
      });
      if (error) {
        results.push({ day, ok: false, error: error.message });
        continue;
      }
      results.push({ day, ok: true, features: fc.features.length });
    } catch (e) {
      results.push({ day, ok: false, error: String(e) });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return json({ ok: okCount > 0, days: results });
}));
