import { defineJob } from '../../lib/harness.ts';
import { env } from '../../lib/env.ts';
// Daily forecast digest for opted-in subscribers.
//
// Cron-invoked each morning (see 20260621000002_daily_forecast.sql). Flow:
//   1. daily_forecast_recipients() RPC → active subscribers with the
//      alert_preferences.daily_forecast flag and a usable point.
//   2. Bucket recipients to ~11 km (0.1°) cells — NWS gridpoints are 2.5 km,
//      so everyone in a cell shares effectively the same forecast text.
//   3. One NWS point-forecast fetch per bucket (api.weather.gov /points →
//      forecast periods), one messages row per bucket with
//      audience_spec = { subscribers: [ids] }, enqueued via
//      enqueue_message_system so the send worker, delivery logs and the
//      dashboard treat it like any other outbound message.
//
// Requires secret NWS_USER_AGENT (same one nws-poll uses). Optional
// CRON_INVOKER_JWT Bearer check when that secret is set.

import { serviceClient, json } from '../../lib/supabase.ts';

type Recipient = { subscriber_id: string; lat: number; lon: number };

type ForecastPeriod = {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
  detailedForecast?: string;
  probabilityOfPrecipitation?: { value?: number | null };
};

// Bound NWS API usage per run. 40 buckets ≈ 80 upstream requests — far more
// than a single-operator subscriber base should ever spread across, but a
// hard stop if locations are ever junk. Overflow buckets are skipped and
// reported in the response.
const MAX_BUCKETS = 40;

const NWS_HEADERS = (ua: string) => ({
  'User-Agent': ua,
  Accept: 'application/geo+json, application/json',
});

function bucketKey(lat: number, lon: number): string {
  return `${lat.toFixed(1)},${lon.toFixed(1)}`;
}

// Body uses the repo's markdown dialect (**bold**, *italic*) which the send
// worker's mdToTelegramHtml converts before the Telegram send.
function fmtPeriod(p: ForecastPeriod, detailed: boolean): string {
  const name = p.name ?? '?';
  if (detailed && p.detailedForecast) return `**${name}:** ${p.detailedForecast}`;
  const bits: string[] = [];
  if (p.shortForecast) bits.push(p.shortForecast);
  if (typeof p.temperature === 'number') bits.push(`${p.temperature}°${p.temperatureUnit ?? 'F'}`);
  const pop = p.probabilityOfPrecipitation?.value;
  if (typeof pop === 'number' && pop >= 20) bits.push(`${pop}% precip`);
  return `**${name}:** ${bits.join(', ') || '—'}`;
}

async function fetchBucketForecast(
  ua: string,
  lat: number,
  lon: number,
): Promise<{ place: string | null; body: string } | null> {
  const ptRes = await fetch(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    { headers: NWS_HEADERS(ua), signal: AbortSignal.timeout(15_000) },
  );
  if (!ptRes.ok) return null;
  const pt = (await ptRes.json()) as {
    properties?: {
      forecast?: string;
      relativeLocation?: { properties?: { city?: string; state?: string } };
    };
  };
  const forecastUrl = pt.properties?.forecast;
  if (!forecastUrl) return null;

  const fcRes = await fetch(forecastUrl, {
    headers: NWS_HEADERS(ua),
    signal: AbortSignal.timeout(15_000),
  });
  if (!fcRes.ok) return null;
  const fc = (await fcRes.json()) as { properties?: { periods?: ForecastPeriod[] } };
  const periods = fc.properties?.periods ?? [];
  if (periods.length === 0) return null;

  const rel = pt.properties?.relativeLocation?.properties;
  const place = rel?.city ? `${rel.city}${rel.state ? `, ${rel.state}` : ''}` : null;

  // First period verbatim (the morning read), next two as one-liners.
  const lines = [
    fmtPeriod(periods[0], true),
    ...periods.slice(1, 3).map((p) => fmtPeriod(p, false)),
  ];
  return { place, body: lines.join('\n\n') };
}

export default defineJob('daily-forecast', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = env('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const ua = env('NWS_USER_AGENT');
  if (!ua?.trim()) return json({ ok: false, error: 'NWS_USER_AGENT secret missing' }, 500);

  const supa = serviceClient();

  const { data: recipients, error: rErr } = await supa.rpc('daily_forecast_recipients');
  if (rErr) return json({ ok: false, error: `recipients: ${rErr.message}` }, 500);
  const recs = (recipients ?? []) as Recipient[];
  if (recs.length === 0) {
    return json({ ok: true, recipients: 0, buckets: 0, messages: 0 });
  }

  // Group into 0.1° cells, keeping the member list per cell so the message
  // audience is the exact opted-in set (resolve_audience re-checks active
  // status at enqueue time).
  const buckets = new Map<string, { lat: number; lon: number; ids: string[] }>();
  for (const r of recs) {
    const key = bucketKey(r.lat, r.lon);
    const b = buckets.get(key);
    if (b) {
      b.ids.push(r.subscriber_id);
    } else {
      buckets.set(key, { lat: r.lat, lon: r.lon, ids: [r.subscriber_id] });
    }
  }

  const all = [...buckets.values()];
  const todo = all.slice(0, MAX_BUCKETS);
  const skippedBuckets = all.length - todo.length;
  if (skippedBuckets > 0) {
    console.warn(`daily-forecast: ${skippedBuckets} bucket(s) over MAX_BUCKETS skipped`);
  }

  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  let messages = 0;
  let queued = 0;
  let failedBuckets = 0;

  for (const b of todo) {
    try {
      const fc = await fetchBucketForecast(ua, b.lat, b.lon);
      if (!fc) {
        failedBuckets++;
        continue;
      }

      const header = fc.place
        ? `🌤 Daily forecast — ${fc.place} — ${dateLabel}`
        : `🌤 Daily forecast — ${dateLabel}`;
      const body =
        `${header}\n\n${fc.body}\n\n` +
        `*Source: National Weather Service. Toggle this digest off any time in ⚙️ Alerts.*`;

      const { data: msg, error: insErr } = await supa
        .from('messages')
        .insert({
          body_md: body,
          body_rendered: body,
          source: 'forecast',
          status: 'draft',
          audience_spec: { subscribers: b.ids },
        })
        .select('id')
        .single();
      if (insErr || !msg) {
        console.error('daily-forecast insert', insErr?.message);
        failedBuckets++;
        continue;
      }

      const { data: count, error: enqErr } = await supa.rpc('enqueue_message_system', {
        p_message_id: msg.id,
      });
      if (enqErr) {
        console.error('daily-forecast enqueue', enqErr.message);
        await supa.from('messages').update({ status: 'failed' }).eq('id', msg.id);
        failedBuckets++;
        continue;
      }

      messages++;
      queued += (count as unknown as number) ?? 0;
    } catch (e) {
      console.error('daily-forecast bucket', e);
      failedBuckets++;
    }
  }

  return json({
    ok: failedBuckets < todo.length || todo.length === 0,
    recipients: recs.length,
    buckets: todo.length,
    skipped_buckets: skippedBuckets,
    failed_buckets: failedBuckets,
    messages,
    queued,
  });
});
