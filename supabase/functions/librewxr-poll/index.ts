// Poll LibreWxR CAP alerts and upsert into cap_alerts.
//
// Runs in parallel with nws-poll: same cron cadence, separate table. Stage 1
// is observation-only — no dispatch happens off cap_alerts yet. Stage 2 will
// add a source-aware dispatcher gated by an env flag.
//
// Default behavior: pulls global CAP alerts (no bbox), ~700 features and ~1 MB
// per poll. Geographic filtering happens at dispatch time based on subscriber
// AOI, so the ingest stays comprehensive.
//
// Configuration (Supabase Edge Function secrets):
//   LIBREWXR_ALERT_BBOX   Optional "minLon,minLat,maxLon,maxLat" to narrow scope
//   CRON_INVOKER_JWT      Optional Bearer secret for pg_cron auth (matches nws-poll)

import { serviceClient, json, withHealthLog } from './supabase.ts';

type LibreWxRFeature = {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: Record<string, unknown> | null;
};

Deno.serve(withHealthLog('librewxr-poll', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ ok: false }, 405);
  }

  // Optional shared-secret check so a public webhook URL can't manually
  // trigger the poller. Matches the pattern used by nws-poll / scheduled-dispatcher.
  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const bbox = Deno.env.get('LIBREWXR_ALERT_BBOX')?.trim();
  const url = bbox
    ? `https://api.librewxr.net/v2/alerts?bbox=${encodeURIComponent(bbox)}`
    : 'https://api.librewxr.net/v2/alerts';

  let features: LibreWxRFeature[] = [];
  try {
    const res = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } });
    if (!res.ok) {
      const t = await res.text();
      return json(
        { ok: false, error: `LibreWxR HTTP ${res.status}`, detail: t.slice(0, 500) },
        502,
      );
    }
    const data = (await res.json()) as { features?: LibreWxRFeature[] };
    features = data.features ?? [];
  } catch (e) {
    console.error('librewxr-poll fetch', e);
    return json({ ok: false, error: String(e) }, 500);
  }

  const supa = serviceClient();
  let upserted = 0;
  let upsertErrors = 0;
  for (const feature of features) {
    const { error } = await supa.rpc('cap_upsert_feature', {
      p_feature: feature as unknown as Record<string, unknown>,
    });
    if (error) {
      upsertErrors++;
      console.error('cap_upsert_feature', error);
      continue;
    }
    upserted++;
  }

  return json({
    ok: true,
    scope: bbox ?? 'global',
    fetched: features.length,
    upserted,
    upsert_errors: upsertErrors,
  });
}));
