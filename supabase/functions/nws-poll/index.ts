// Poll national active alerts from api.weather.gov, upsert into nws_alerts, supersede references.
// Requires secret NWS_USER_AGENT (contact string per NWS policy).

import { serviceClient, json } from './_shared/supabase.ts';

function parseNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const ua = Deno.env.get('NWS_USER_AGENT');
  if (!ua?.trim()) return json({ ok: false, error: 'NWS_USER_AGENT secret missing' }, 500);

  const supa = serviceClient();
  const features: Record<string, unknown>[] = [];
  let url: string | null = 'https://api.weather.gov/alerts/active';
  let pages = 0;

  try {
    while (url && pages < 30) {
      const res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          Accept: 'application/geo+json, application/json',
        },
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
  } catch (e) {
    console.error('nws-poll fetch', e);
    return json({ ok: false, error: String(e) }, 500);
  }

  let upserted = 0;
  let supersededRefs = 0;

  for (const feature of features) {
    const { error: upErr } = await supa.rpc('nws_upsert_geojson_feature', {
      p_feature: feature as unknown as Record<string, unknown>,
    });
    if (upErr) {
      console.error('nws_upsert_geojson_feature', upErr);
      continue;
    }
    upserted++;

    const props = feature.properties as Record<string, unknown> | undefined;
    const refsRaw = typeof props?.references === 'string' ? props.references.trim() : '';
    if (refsRaw) {
      const urls = refsRaw.split(/\s+/).filter(Boolean);
      const { error: refErr } = await supa.rpc('nws_mark_references_superseded', {
        p_reference_urls: urls,
      });
      if (!refErr) supersededRefs += urls.length;
      else console.error('nws_mark_references_superseded', refErr);
    }
  }

  return json({
    ok: true,
    pages,
    features: features.length,
    upsert_attempts: upserted,
    superseded_ref_urls: supersededRefs,
  });
});
