// F9: Poll the Fly.io renderer's /couplets/scan endpoint for each Mid-South
// NEXRAD site and persist detected gate-to-gate velocity couplets to
// public.radar_couplets. The renderer-side detector lives in
// _renderer/couplet_detect.py (sibling repo midsouthwx-radar-renderer); this
// function is the Supabase-side bridge that turns those detections into
// stable "rotation IDs" the operator can refer to on /radar.
//
// Runs every minute via pg_cron (see 20260612000006_radar_couplets_cron.sql).
// Sites are scanned in parallel; one slow site doesn't block the others.
//
// Idempotency: the public.radar_couplets_upsert RPC keys on
// (site, volume_time_utc, lat, lon), so re-polling a volume we've already
// ingested just refreshes the row in place. Track IDs are assigned by the
// RPC based on a 5 km / 12 min spatial-temporal match to prior detections.

import { serviceClient, json, withHealthLog } from './supabase.ts';

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

// Same list as MIDSOUTH_SITES in _renderer/couplet_detect.py — kept in sync
// manually. Both ends must agree on which sites are scannable; the renderer
// rejects an unknown site with HTTP 400. If you change this, also update
// `lib/radar/sites.ts` and the docstring in couplet_detect.py.
const MIDSOUTH_SITES = [
  'KNQA', // Memphis, TN
  'KDGX', // Jackson, MS
  'KGWX', // Columbus AFB, MS
  'KOHX', // Nashville, TN
  'KLZK', // Little Rock, AR
  'KHTX', // Hytop, AL
  'KPAH', // Paducah, KY
  'KMRX', // Morristown, TN
] as const;

// Per-site request timeout. Cold-starting the Fly machine + listing S3 +
// reading a ~5 MB Level II volume + Py-ART dealias takes ~15–45 s on first
// call; warm calls land in 3–10 s. 60 s is comfortably above the worst case
// without letting a hung scan block the function's wall-clock budget.
const PER_SITE_TIMEOUT_MS = 60_000;

type Detection = {
  lon: number;
  lat: number;
  shear_kt: number;
  range_km: number;
  azimuth_deg: number;
};

type CoupletScanResponse = {
  site: string;
  volume_filename: string;
  volume_time_utc: string;
  scan_age_seconds: number;
  elevation_deg: number;
  radar_lat: number;
  radar_lon: number;
  detections: Detection[];
  candidates_before_cluster: number;
  scan_ms: number;
};

type SiteResult = {
  site: string;
  ok: boolean;
  detections?: number;
  inserted?: number;
  inherited?: number;
  volume_time?: string;
  scan_age_s?: number;
  error?: string;
  status?: number;
};

async function scanOneSite(
  site: string,
  base: string,
  token: string,
  supa: ReturnType<typeof serviceClient>,
): Promise<SiteResult> {
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/couplets/scan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ site }),
      signal: AbortSignal.timeout(PER_SITE_TIMEOUT_MS),
    });

    if (!r.ok) {
      // 503 from the renderer means "latest volume is too stale" — that's
      // the radar being down or in maintenance, not our problem; record it
      // as a non-fatal skip so the function still reports ok=true overall.
      const body = await r.text().catch(() => '');
      return { site, ok: r.status === 503, status: r.status, error: body.slice(0, 200) };
    }

    const data = (await r.json()) as CoupletScanResponse;
    let inserted = 0;
    let inherited = 0;

    // Per-detection RPCs keep the track_id assignment logic centralized in
    // SQL. 8 sites × typical ~0–5 detections per site = at most ~40 RPCs
    // per minute; a single multi-row RPC would shave some round-trips but
    // isn't worth the schema complexity at this volume.
    for (const d of data.detections) {
      const { data: rows, error } = await supa.rpc('radar_couplets_upsert', {
        p_site: data.site,
        p_lat: d.lat,
        p_lon: d.lon,
        p_shear_kt: d.shear_kt,
        p_range_km: d.range_km,
        p_azimuth_deg: d.azimuth_deg,
        p_elevation_deg: data.elevation_deg,
        p_volume_filename: data.volume_filename,
        p_volume_time_utc: data.volume_time_utc,
        p_scan_age_seconds: data.scan_age_seconds,
      });
      if (error) {
        console.error('radar_couplets_upsert', site, error.message);
        continue;
      }
      inserted++;
      const first = Array.isArray(rows) ? rows[0] : rows;
      if (first && (first as { inherited?: boolean }).inherited) inherited++;
    }

    return {
      site,
      ok: true,
      detections: data.detections.length,
      inserted,
      inherited,
      volume_time: data.volume_time_utc,
      scan_age_s: data.scan_age_seconds,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes('timeout') || msg.includes('aborted')
      ? 'timeout' : 'fetch_error';
    return { site, ok: false, error: `${code}: ${msg}` };
  }
}

Deno.serve(withHealthLog('couplet-poll', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const base = Deno.env.get('RENDERER_BASE_URL');
  const token = Deno.env.get('RENDERER_TOKEN');
  if (!base || !token) {
    return json({ ok: false, error: 'renderer_not_configured' }, 503);
  }

  const supa = serviceClient();

  // Renderer VM is shared-cpu-2x:4GB; a velocity render holds ~600 MB resident
  // and an 8-wide Promise.all fan-out has OOM'd the machine in production
  // (PR01 + restart cycle). Cap concurrency at 4 — well under the documented
  // "4–6 concurrent renders" headroom in _renderer/fly.toml — and let the
  // remaining sites queue. Total wall-clock cost is bounded by
  // PER_SITE_TIMEOUT_MS × ceil(sites / CONCURRENCY) = 60 s × 2 = 120 s, still
  // inside the function's budget.
  const CONCURRENCY = 4;
  const queue = [...MIDSOUTH_SITES];
  const results: Awaited<ReturnType<typeof scanOneSite>>[] = [];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const site = queue.shift();
      if (!site) return;
      results.push(await scanOneSite(site, base, token, supa));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, MIDSOUTH_SITES.length) }, () => worker()),
  );

  const totals = results.reduce(
    (acc, r) => {
      acc.sites++;
      if (r.ok) acc.sites_ok++;
      acc.detections += r.detections ?? 0;
      acc.inserted += r.inserted ?? 0;
      acc.inherited += r.inherited ?? 0;
      return acc;
    },
    { sites: 0, sites_ok: 0, detections: 0, inserted: 0, inherited: 0 },
  );

  // We report ok=true unless every site failed. A single radar going dark
  // for maintenance shouldn't fail the cron run; only a renderer-wide
  // outage should page the operator.
  const overallOk = totals.sites_ok > 0;
  return json({
    ok: overallOk,
    ...totals,
    sites_detail: results,
  });
}));
