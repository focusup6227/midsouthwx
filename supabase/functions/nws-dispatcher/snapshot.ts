// Calls the sibling Fly renderer's /alert-snapshot endpoint to produce a
// PNG (warning polygon + storm track over a dark basemap) and returns the
// public Supabase Storage URL. The caller writes it to messages.media_url so
// the send worker switches sendMessage → sendPhoto with the body as caption.
//
// After the synchronous static snapshot lands, we *also* fire the heavier
// /alert-loop endpoint asynchronously via EdgeRuntime.waitUntil — when (if)
// the MP4 finishes before the worker claims the queue rows, we UPDATE
// messages.media_url + media_type to swap the static for the loop. If it
// doesn't finish in time (cold renderer, slow S3 fetch), subscribers just
// get the static — no warning delay.
//
// Failure mode is "skip the snapshot, send text only" — never fail the
// dispatch. The helper logs and returns null on any error.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { nearestNexradSite } from './_shared_sites.ts';

const KTS_TO_KM_PER_MIN = 1.852 / 60;
const FORECAST_MINUTES = 30; // projection horizon for the rendered arrow
const REQUEST_TIMEOUT_MS = 25_000;

type AlertGeoSummary = {
  polygon: unknown; // GeoJSON geometry (Polygon | MultiPolygon)
  observed: [number, number][];
  forecast: [number, number][];
};

const EMD_HEAD_RE =
  /(\d+(?:\.\d+)?)\s*DEG\s*\.\.\.\s*(\d+(?:\.\d+)?)\s*KT\s*\.\.\.\s*([-\d.,\s]+)/i;
const EMD_PAIR_RE = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g;

function projectPoint(
  lon: number,
  lat: number,
  directionDeg: number,
  distanceKm: number,
): [number, number] {
  const rad = (directionDeg * Math.PI) / 180;
  const dLat = (distanceKm / 111.32) * Math.cos(rad);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLon =
    cosLat > 1e-9 ? (distanceKm / (111.32 * cosLat)) * Math.sin(rad) : 0;
  return [lon + dLon, lat + dLat];
}

/** Extract polygon + observed/forecast tracks from the NWS feature's raw JSON. */
function buildGeoSummary(raw: unknown): AlertGeoSummary | null {
  const obj = raw as
    | {
        geometry?: unknown;
        properties?: { parameters?: Record<string, unknown> };
      }
    | null;
  const geom = obj?.geometry as
    | { type?: string; coordinates?: unknown }
    | null
    | undefined;
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
    return null;
  }

  const params = obj?.properties?.parameters ?? {};
  const emdRaw = (params as Record<string, unknown>).eventMotionDescription;
  const emdStr =
    typeof emdRaw === 'string'
      ? emdRaw
      : Array.isArray(emdRaw)
        ? String(emdRaw[0] ?? '')
        : '';

  const observed: [number, number][] = [];
  let forecast: [number, number][] = [];

  if (emdStr) {
    const m = emdStr.match(EMD_HEAD_RE);
    if (m) {
      const fromDeg = parseFloat(m[1]);
      const kts = parseFloat(m[2]);
      const points: [number, number][] = [];
      for (const pair of m[3].matchAll(EMD_PAIR_RE)) {
        const lat = parseFloat(pair[1]);
        const lon = parseFloat(pair[2]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          points.push([lon, lat]);
        }
      }
      if (points.length > 0 && Number.isFinite(fromDeg) && Number.isFinite(kts)) {
        // NWS lists current first; reverse so observed runs past→present.
        points.reverse();
        observed.push(...points);
        if (kts > 0) {
          const anchor = observed[observed.length - 1];
          const towardDeg = (fromDeg + 180) % 360;
          const distKm = kts * KTS_TO_KM_PER_MIN * FORECAST_MINUTES;
          const end = projectPoint(anchor[0], anchor[1], towardDeg, distKm);
          forecast = [anchor, end];
        }
      }
    }
  }

  return { polygon: geom, observed, forecast };
}

function isSnapshotEligible(event: string): boolean {
  const e = event.toLowerCase();
  if (!e.includes('warning') && !e.includes('emergency')) return false;
  return (
    e.includes('tornado') ||
    e.includes('severe thunderstorm') ||
    e.includes('flash flood') ||
    e.includes('special marine')
  );
}

/**
 * Render the snapshot via the renderer and stamp `messages.media_url` /
 * `media_type` so the worker sends it as a photo with the body as caption.
 * No-op when env is unset, the alert isn't convective, or the renderer
 * call fails — always returns void.
 */
export async function attachAlertSnapshot(
  supa: SupabaseClient,
  args: { messageId: string; alertId: string; event: string; raw: unknown },
): Promise<void> {
  if (!isSnapshotEligible(args.event)) return;

  const base = Deno.env.get('RENDERER_BASE_URL');
  const token = Deno.env.get('RENDERER_TOKEN');
  if (!base || !token) return; // renderer not configured — graceful skip

  const summary = buildGeoSummary(args.raw);
  if (!summary) return; // no usable polygon

  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/alert-snapshot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        alert_id: args.alertId,
        event: args.event,
        polygon: summary.polygon,
        observed: summary.observed,
        forecast: summary.forecast,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        '[snapshot] renderer rejected',
        resp.status,
        body.slice(0, 200),
      );
      return;
    }

    const data = (await resp.json()) as { url?: string };
    if (!data.url) return;

    const { error } = await supa
      .from('messages')
      .update({ media_url: data.url, media_type: 'photo' })
      .eq('id', args.messageId);
    if (error) console.error('[snapshot] update messages.media_url', error);

    // Static is in place; kick off the heavier MP4 loop in the background.
    // If it finishes before the worker claims the queue rows, the next
    // claim_outbound_batch read picks up the swapped media_url.
    fireAlertLoopAsync(supa, {
      messageId: args.messageId,
      alertId: args.alertId,
      event: args.event,
      polygon: summary.polygon,
    });
  } catch (e) {
    // Cold starts can hit the 25 s timeout; that's fine — we send text-only.
    console.error('[snapshot] call failed', e);
  }
}

// ---------- async loop generation ----------

const LOOP_REQUEST_TIMEOUT_MS = 90_000;

/** Fire the renderer's /alert-loop and swap messages.media_url to the MP4
 *  when it completes. Uses EdgeRuntime.waitUntil so the dispatcher can
 *  return immediately while the loop renders in the background. Falls back
 *  to a plain fire-and-forget when waitUntil isn't available (local dev). */
function fireAlertLoopAsync(
  supa: SupabaseClient,
  args: { messageId: string; alertId: string; event: string; polygon: unknown },
): void {
  const site = nearestNexradSite(args.polygon as { type?: string; coordinates?: unknown } | null);
  if (!site) return; // polygon centroid outside our covered area — skip

  const work = renderAndSwapLoop(supa, { ...args, siteCode: site.code });

  // Supabase Edge runtime exposes EdgeRuntime.waitUntil to keep async work
  // alive past the response. If we're somewhere it isn't (dev / local
  // serve), fall back to a detached promise — Deno keeps the worker alive
  // long enough for small payloads, and we don't care about the result.
  const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') {
    rt.waitUntil(work);
  } else {
    work.catch((e) => console.error('[loop] detached failure', e));
  }
}

async function renderAndSwapLoop(
  supa: SupabaseClient,
  args: { messageId: string; alertId: string; event: string; polygon: unknown; siteCode: string },
): Promise<void> {
  const base = Deno.env.get('RENDERER_BASE_URL');
  const token = Deno.env.get('RENDERER_TOKEN');
  if (!base || !token) return;

  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/alert-loop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        alert_id: args.alertId,
        event: args.event,
        polygon: args.polygon,
        site: args.siteCode,
      }),
      signal: AbortSignal.timeout(LOOP_REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[loop] renderer rejected', resp.status, body.slice(0, 200));
      return;
    }
    const data = (await resp.json()) as { url?: string };
    if (!data.url) return;

    // Swap to animation. If the worker already claimed and sent the static,
    // this UPDATE is harmless — the row's already gone out. Next cron tick
    // is the latest the loop can possibly land, hence the 90 s timeout.
    const { error } = await supa
      .from('messages')
      .update({ media_url: data.url, media_type: 'animation' })
      .eq('id', args.messageId);
    if (error) console.error('[loop] update messages.media_url', error);
  } catch (e) {
    // Most common: AbortError on cold-start renderers. We logged it; the
    // static snapshot already attached above keeps the alert useful.
    console.error('[loop] call failed', e);
  }
}
