// Poll national active alerts from api.weather.gov, upsert into nws_alerts, supersede references.
// Requires secret NWS_USER_AGENT (contact string per NWS policy).
// Self-schedules a follow-up poll ~30s later when invoked by cron (2×/min effective rate).

import { serviceClient, json, withHealthLog } from './supabase.ts';
import { fetchSpcMesoscaleDiscussions, nwsIdFromAlertFeature } from './spc-md.ts';
import { summarizePendingWarnings } from './summarize.ts';

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

function parseNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

function scheduleFollowUpPoll(req: Request) {
  if (req.headers.get('X-NWS-Poll-Followup') === '1') return;

  const base = Deno.env.get('SUPABASE_URL');
  if (!base) return;

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-NWS-Poll-Followup': '1',
  };
  if (cronJwt) headers['Authorization'] = `Bearer ${cronJwt}`;

  const followUp = new Promise<void>((resolve) => {
    setTimeout(async () => {
      try {
        await fetch(`${base.replace(/\/$/, '')}/functions/v1/nws-poll`, {
          method: 'POST',
          headers,
          body: '{}',
        });
      } catch (e) {
        console.error('nws-poll follow-up', e);
      }
      resolve();
    }, 30_000);
  });

  try {
    EdgeRuntime.waitUntil(followUp);
  } catch {
    // Local dev may not expose EdgeRuntime.waitUntil
  }
}

Deno.serve(withHealthLog('nws-poll', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const ua = Deno.env.get('NWS_USER_AGENT');
  if (!ua?.trim()) return json({ ok: false, error: 'NWS_USER_AGENT secret missing' }, 500);

  const supa = serviceClient();
  const features: Record<string, unknown>[] = [];
  let url: string | null = 'https://api.weather.gov/alerts/active';
  let pages = 0;
  // Sanity cap: prevents an infinite loop if NWS pagination ever loops, but
  // high enough that even a major nationwide outbreak (10K+ active alerts)
  // doesn't drop tail pages. The earlier 30-page cap silently lost alerts
  // during multi-state severe-weather days.
  const HARD_PAGE_CAP = 200;

  try {
    while (url && pages < HARD_PAGE_CAP) {
      const res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          Accept: 'application/geo+json, application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const t = await res.text();
        return json({ ok: false, error: `NWS HTTP ${res.status}`, detail: t.slice(0, 500) }, 502);
      }
      const data = (await res.json()) as { features?: Record<string, unknown>[] };
      features.push(...(data.features ?? []));
      url = parseNextUrl(res.headers.get('Link'));
      pages++;
    }
    if (url) {
      console.warn(`nws-poll hit HARD_PAGE_CAP (${HARD_PAGE_CAP}); more pages exist`);
    }
  } catch (e) {
    console.error('nws-poll fetch', e);
    return json({ ok: false, error: String(e) }, 500);
  }

  const spcFeatures = await fetchSpcMesoscaleDiscussions(supa);
  features.push(...spcFeatures);

  const activeNwsIds: string[] = [];
  let upserted = 0;
  let supersededRefs = 0;

  for (const feature of features) {
    const nid = nwsIdFromAlertFeature(feature);
    if (nid) activeNwsIds.push(nid);
    const { error: upErr } = await supa.rpc('nws_upsert_geojson_feature', {
      p_feature: feature as unknown as Record<string, unknown>,
    });
    if (upErr) {
      console.error('nws_upsert_geojson_feature', upErr);
      continue;
    }
    upserted++;

    const props = feature.properties as Record<string, unknown> | undefined;
    // api.weather.gov returns `references` as an array of objects
    // ({ '@id', identifier, sent, sender }); some upstream sources
    // (e.g. SPC MD scraping in spc-md.ts) still emit it as a space-
    // separated string. Accept both shapes — without this the supersede
    // path silently no-ops, leaving every continuation/update polygon
    // stacked on top of its predecessors on /radar.
    const refsField = props?.references;
    let urls: string[] = [];
    if (Array.isArray(refsField)) {
      urls = refsField
        .map((r) => {
          if (typeof r === 'string') return r;
          if (r && typeof r === 'object') {
            const o = r as { '@id'?: unknown; identifier?: unknown };
            if (typeof o['@id'] === 'string') return o['@id'];
            if (typeof o.identifier === 'string') return o.identifier;
          }
          return '';
        })
        .filter((u) => u.length > 0);
    } else if (typeof refsField === 'string' && refsField.trim()) {
      urls = refsField.trim().split(/\s+/).filter(Boolean);
    }
    if (urls.length) {
      const { error: refErr } = await supa.rpc('nws_mark_references_superseded', {
        p_reference_urls: urls,
      });
      if (!refErr) supersededRefs += urls.length;
      else console.error('nws_mark_references_superseded', refErr);
    }
  }

  let expiredStale = 0;
  const { data: syncCount, error: syncErr } = await supa.rpc('nws_sync_active_alerts', {
    p_active_nws_ids: activeNwsIds,
  });
  if (syncErr) console.error('nws_sync_active_alerts', syncErr);
  else if (typeof syncCount === 'number') expiredStale = syncCount;

  // F2: kick off AI summarization for any unsummarized warning rows. Runs
  // after the response is sent (waitUntil) so a slow DeepSeek call never
  // delays the next poll cycle. Failures are swallowed inside the helper —
  // the next poll picks up whatever stayed null.
  try {
    EdgeRuntime.waitUntil(
      summarizePendingWarnings(supa).catch((e) =>
        console.error('summarizePendingWarnings', e),
      ),
    );
  } catch {
    // Local dev may not expose EdgeRuntime.waitUntil — fire-and-forget.
    summarizePendingWarnings(supa).catch((e) =>
      console.error('summarizePendingWarnings', e),
    );
  }

  scheduleFollowUpPoll(req);

  return json({
    ok: true,
    pages,
    features: features.length,
    spc_md: spcFeatures.length,
    upsert_attempts: upserted,
    superseded_ref_urls: supersededRefs,
    expired_stale: expiredStale,
    followup_scheduled: req.headers.get('X-NWS-Poll-Followup') !== '1',
  });
}));
