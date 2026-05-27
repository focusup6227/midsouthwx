// F4: Pull NWS Local Storm Reports from the IEM (Iowa Environmental Mesonet)
// GeoJSON feed and upsert into nws_storm_reports. IEM normalizes the raw
// LSR text products into structured lat/lon/event/magnitude features.
//
// NWS itself doesn't expose LSRs as structured GeoJSON — the official API
// returns the original text products which would need their own parser. IEM
// is the standard third-party path used by basically every public-facing
// LSR map (radar.weather.gov even points at IEM internally for some of its
// downstream products).
//
// Cron: every 5 minutes. The endpoint serves the last ~24h of LSRs by
// default; we ask for the last 6h to keep the payload small. Upserts are
// idempotent on the IEM product_id so overlapping windows just refresh.

import { serviceClient, json, withHealthLog } from './supabase.ts';

const LOOKBACK_HOURS = 6;
const IEM_URL_BASE = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson';

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

function buildLsrUrl(): string {
  const now = new Date();
  const past = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');
  // The IEM endpoint accepts sts/ets ISO timestamps. No WFO filter — we let
  // the radar geojson function spatial-filter to the mid-south envelope so
  // we don't have to keep a WFO list in sync with the AOR.
  const params = new URLSearchParams();
  params.set('sts', iso(past));
  params.set('ets', iso(now));
  return `${IEM_URL_BASE}?${params.toString()}`;
}

Deno.serve(withHealthLog('lsr-poll', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const ua = Deno.env.get('NWS_USER_AGENT') || 'midsouthwx (contact: operator@midsouthwx)';
  const url = buildLsrUrl();

  let features: Record<string, unknown>[] = [];
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': ua,
        Accept: 'application/geo+json, application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const t = await res.text();
      return json({ ok: false, error: `IEM HTTP ${res.status}`, detail: t.slice(0, 500) }, 502);
    }
    const data = (await res.json()) as { features?: Record<string, unknown>[] };
    features = data.features ?? [];
  } catch (e) {
    console.error('lsr-poll fetch', e);
    return json({ ok: false, error: String(e) }, 500);
  }

  const supa = serviceClient();
  let upserted = 0;
  let skipped = 0;

  // Per-feature upsert via the RPC keeps the hazard classification + geometry
  // logic in one place (the SQL function). Serial loop is fine for the ~50–
  // 500 features per poll. If this grows, batch into a single multi-row RPC.
  for (const feature of features) {
    try {
      const { error } = await supa.rpc('nws_storm_reports_upsert', {
        p_feature: feature as unknown as Record<string, unknown>,
      });
      if (error) {
        console.error('nws_storm_reports_upsert', error.message);
        skipped++;
        continue;
      }
      upserted++;
    } catch (e) {
      console.error('lsr-poll loop', e);
      skipped++;
    }
  }

  return json({
    ok: true,
    fetched: features.length,
    upserted,
    skipped,
    window_hours: LOOKBACK_HOURS,
  });
}));
