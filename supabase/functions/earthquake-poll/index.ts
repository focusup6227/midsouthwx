// USGS earthquake watch for the New Madrid seismic zone.
//
// Every 10 min (pg_cron), queries the USGS FDSN event API for M3.0+ quakes
// in the Mid-South box over the last 2 hours, dedups against
// public.earthquake_events, and DMs the operator(s) for anything new.
// Operator-notification only — subscriber messaging for quakes stays a
// deliberate human decision via /compose.

import { serviceClient, json, withHealthLog } from './supabase.ts';

const BBOX = { minLat: 33.0, maxLat: 38.5, minLon: -93.0, maxLon: -85.0 };
const MIN_MAG = 3.0;

type UsgsFeature = {
  id: string;
  properties: { mag: number | null; place: string | null; time: number };
  geometry: { coordinates: [number, number, number] };
};

async function sendTelegram(token: string, chatId: number, text: string): Promise<boolean> {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  return r.ok;
}

Deno.serve(withHealthLog('earthquake-poll', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const supa = serviceClient();
  const since = new Date(Date.now() - 2 * 3600_000).toISOString();
  const url =
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&starttime=${encodeURIComponent(since)}` +
    `&minmagnitude=${MIN_MAG}` +
    `&minlatitude=${BBOX.minLat}&maxlatitude=${BBOX.maxLat}` +
    `&minlongitude=${BBOX.minLon}&maxlongitude=${BBOX.maxLon}`;

  let features: UsgsFeature[] = [];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return json({ ok: false, error: `usgs ${res.status}` }, 502);
    features = ((await res.json())?.features ?? []) as UsgsFeature[];
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
  if (features.length === 0) return json({ ok: true, quakes: 0, notified: 0 });

  // Dedup against already-notified events.
  const ids = features.map((f) => f.id);
  const { data: seen } = await supa
    .from('earthquake_events')
    .select('usgs_id')
    .in('usgs_id', ids);
  const seenSet = new Set((seen ?? []).map((r) => r.usgs_id));
  const fresh = features.filter((f) => !seenSet.has(f.id) && (f.properties.mag ?? 0) >= MIN_MAG);
  if (fresh.length === 0) return json({ ok: true, quakes: features.length, notified: 0 });

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  const { data: ops } = await supa
    .from('operators')
    .select('telegram_chat_id')
    .not('telegram_chat_id', 'is', null);

  let notified = 0;
  for (const f of fresh) {
    const [lon, lat, depth] = f.geometry.coordinates;
    const mag = f.properties.mag ?? 0;
    const when = new Date(f.properties.time);
    await supa.from('earthquake_events').upsert(
      {
        usgs_id: f.id,
        magnitude: mag,
        place: f.properties.place,
        occurred_at: when.toISOString(),
        lat,
        lon,
      },
      { onConflict: 'usgs_id' },
    );

    if (!token) continue;
    const text =
      `🌎 <b>M${mag.toFixed(1)} earthquake</b> — ${f.properties.place ?? 'Mid-South region'}\n` +
      `${when.toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT · depth ${Math.round(depth)} km\n` +
      `<a href="https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}">USGS event page</a>\n\n` +
      `Felt reports likely${mag >= 4 ? ' — consider a subscriber notice via /compose' : ''}.`;
    for (const op of ops ?? []) {
      if (op.telegram_chat_id && (await sendTelegram(token, op.telegram_chat_id, text))) notified++;
    }
  }

  return json({ ok: true, quakes: features.length, fresh: fresh.length, notified });
}));
