// F9 (extension): NEXRAD couplet pre-alert dispatcher, SHADOW MODE.
//
// Reads recent persistent rotation tracks from public.radar_couplets,
// applies the tiered environmental filter (PDS Tornado Watch / Tornado
// Watch / Severe T-Storm Watch), projects the rotation forward N minutes
// to compute a hypothetical impact swath, then matches subscribers whose
// location falls inside it. The complete evaluation is persisted to
// public.couplet_alerts so we can tune thresholds against real weather.
//
// CRITICAL: this function never inserts into messages or outbound_queue
// while COUPLET_DISPATCHER_LIVE is unset/!=1. Subscribers receive
// nothing. The shadow-mode states ('shadow', 'shadow_no_env',
// 'shadow_below_tier', 'shadow_no_audience', 'shadow_suppressed_nws')
// describe what *would* have happened. Live mode is a separate code path
// to add later, after threshold tuning.
//
// Runs every minute via pg_cron. The couplet-poll function (every minute,
// :00 second mark) writes detections; this runs at :30 to give the poll
// time to land first — see the cron migration.

import { serviceClient, json, withHealthLog } from './supabase.ts';

const WINDOW_MINUTES = 20;        // how far back to consider a track "live"
const MIN_VOLUMES = 3;             // persistence floor (~12-15 min at 4-5 min VCP)
const MIN_SHEAR_FLOOR_KT = 60.0;   // shear floor below tier-specific gating
const DEDUP_MINUTES = 30;          // one alert per track per this window
const PROJECTION_MINUTES = 10;     // how far ahead we project the swath
const SWATH_WIDTH_KM = 4.0;        // perpendicular buffer on the projected line

// Tier-specific shear thresholds. Read together with the environment
// returned by public.couplet_environment(lat, lon). Outside any qualifying
// watch we never reach live-mode firing, but in shadow mode we still log
// the decision so we can analyze "would we have wanted to fire here?"
const TIER_THRESHOLD_KT: Record<string, number> = {
  PDS_TOR: 60.0,
  TOR: 70.0,
  SVR: 80.0,
};

// Mode-of-operation matrix per tier. Reserved for live mode; shadow
// runs collect data for all tiers identically. Once we flip
// COUPLET_DISPATCHER_LIVE=1, these decide whether a tier auto-fires,
// goes to operator review, or only self-notifies the operator.
// const TIER_MODE: Record<string, 'auto' | 'review' | 'self_notify_only'> = {
//   PDS_TOR: 'auto',
//   TOR: 'auto',
//   SVR: 'review',
// };

Deno.serve(withHealthLog('couplet-dispatcher', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  // Hard guard: live mode requires explicit opt-in. While unset, every
  // decision lands as a shadow_* status and nothing reaches messages or
  // outbound_queue. The check is duplicated in every code path that
  // would otherwise insert a message.
  const liveMode = Deno.env.get('COUPLET_DISPATCHER_LIVE') === '1';
  if (liveMode) {
    // Reserved for the future implementation. Until then, fail loud so
    // we don't accidentally hot-pipe shadow logic into subscriber sends.
    return json({
      ok: false,
      error: 'live_mode_not_implemented',
      note: 'remove COUPLET_DISPATCHER_LIVE env var to run shadow mode',
    }, 501);
  }

  const supa = serviceClient();

  const { data: candidates, error: candErr } = await supa.rpc(
    'claim_couplet_candidate_tracks',
    {
      p_window_minutes: WINDOW_MINUTES,
      p_min_volumes: MIN_VOLUMES,
      p_min_shear_kt: MIN_SHEAR_FLOOR_KT,
      p_dedup_minutes: DEDUP_MINUTES,
    },
  );
  if (candErr) {
    console.error('claim_couplet_candidate_tracks', candErr);
    return json({ ok: false, error: candErr.message }, 500);
  }

  const tracks = (candidates ?? []) as Array<{
    track_id: string;
    max_shear_kt: number;
    volume_count: number;
  }>;

  const outcomes: Record<string, number> = {};
  const bump = (k: string) => { outcomes[k] = (outcomes[k] ?? 0) + 1; };
  const inserted: Array<{ track_id: string; status: string; tier: string | null; audience: number }> = [];

  for (const t of tracks) {
    try {
      // Motion + latest position
      const { data: motionRows, error: motionErr } = await supa.rpc(
        'couplet_track_motion',
        { p_track_id: t.track_id, p_window_minutes: WINDOW_MINUTES },
      );
      if (motionErr) {
        console.error('couplet_track_motion', t.track_id, motionErr.message);
        bump('motion_error');
        continue;
      }
      const motion = (Array.isArray(motionRows) ? motionRows[0] : motionRows) as
        | {
            detections: number;
            max_shear_kt: number;
            latest_lat: number;
            latest_lon: number;
            latest_volume_time: string;
            motion_bearing_deg: number | null;
            motion_speed_kmh: number | null;
          }
        | undefined;
      if (!motion) { bump('no_motion'); continue; }

      // Environmental tier at the latest detection position
      const { data: envRows, error: envErr } = await supa.rpc(
        'couplet_environment',
        { p_lat: motion.latest_lat, p_lon: motion.latest_lon },
      );
      if (envErr) {
        console.error('couplet_environment', t.track_id, envErr.message);
        bump('env_error');
        continue;
      }
      const env = (Array.isArray(envRows) ? envRows[0] : envRows) as
        | { tier: string | null; watch_alert_id: string | null; watch_event: string | null }
        | undefined;
      const tier = env?.tier ?? null;
      const tierThreshold = tier ? TIER_THRESHOLD_KT[tier] ?? null : null;

      // Decide the shadow-mode status. Even when env/threshold gates fail,
      // we still log the track so the analysis dataset is complete.
      let status: string;
      if (!tier) {
        status = 'shadow_no_env';
      } else if (tierThreshold !== null && t.max_shear_kt < tierThreshold) {
        status = 'shadow_below_tier';
      } else {
        // Compute projected swath. If motion is unknown (single position
        // or all detections at the same time), we can't project and we
        // skip the swath; the audience query falls back to null.
        status = 'shadow';
      }

      let audienceIds: string[] = [];
      let suppressingNwsId: string | null = null;

      if (status === 'shadow' && motion.motion_bearing_deg !== null && motion.motion_speed_kmh !== null) {
        // Audience: subscribers active with a location point inside the
        // projected swath. The RPC reconstructs the swath internally from
        // the motion params — no need to round-trip the geometry through
        // TS. Projection params are stored on couplet_alerts so analysis
        // queries can rebuild the swath deterministically later.
        const { data: audRows, error: audErr } = await supa.rpc(
          'couplet_shadow_audience',
          {
            p_lat: motion.latest_lat,
            p_lon: motion.latest_lon,
            p_bearing_deg: motion.motion_bearing_deg,
            p_speed_kmh: motion.motion_speed_kmh,
            p_minutes: PROJECTION_MINUTES,
            p_width_km: SWATH_WIDTH_KM,
          },
        );
        if (audErr) {
          console.error('couplet_shadow_audience', t.track_id, audErr.message);
        } else {
          audienceIds = (audRows ?? []).map((r: { subscriber_id: string }) => r.subscriber_id);
        }

        // NWS suppression check: if a Tornado Warning polygon already
        // covers the projected swath, treat this as already-warned. We
        // log it but classify it differently for the tuning analysis.
        const { data: supRows, error: supErr } = await supa.rpc(
          'couplet_nws_suppressor',
          {
            p_lat: motion.latest_lat,
            p_lon: motion.latest_lon,
            p_bearing_deg: motion.motion_bearing_deg,
            p_speed_kmh: motion.motion_speed_kmh,
            p_minutes: PROJECTION_MINUTES,
            p_width_km: SWATH_WIDTH_KM,
          },
        );
        if (!supErr && Array.isArray(supRows) && supRows.length > 0) {
          suppressingNwsId = (supRows[0] as { nws_alert_id: string }).nws_alert_id;
          status = 'shadow_suppressed_nws';
        } else if (audienceIds.length === 0) {
          status = 'shadow_no_audience';
        }
      }

      const { error: insErr } = await supa.from('couplet_alerts').insert({
        track_id: t.track_id,
        shear_kt: t.max_shear_kt,
        persistence_volumes: t.volume_count,
        latest_lat: motion.latest_lat,
        latest_lon: motion.latest_lon,
        latest_volume_time: motion.latest_volume_time,
        environment_tier: tier,
        watch_alert_id: env?.watch_alert_id ?? null,
        watch_event: env?.watch_event ?? null,
        tier_threshold_kt: tierThreshold,
        motion_bearing_deg: motion.motion_bearing_deg,
        motion_speed_kmh: motion.motion_speed_kmh,
        projection_minutes: PROJECTION_MINUTES,
        projected_width_km: SWATH_WIDTH_KM,
        audience_count: audienceIds.length,
        audience_subscriber_ids: audienceIds.length > 0 ? audienceIds : null,
        status,
        suppressing_nws_alert_id: suppressingNwsId,
        notes: null,
      });
      if (insErr) {
        console.error('insert couplet_alerts', t.track_id, insErr.message);
        bump('insert_error');
        continue;
      }

      bump(status);
      inserted.push({ track_id: t.track_id, status, tier, audience: audienceIds.length });
    } catch (e) {
      console.error('track loop', t.track_id, e instanceof Error ? e.message : String(e));
      bump('exception');
    }
  }

  return json({
    ok: true,
    mode: 'shadow',
    candidates: tracks.length,
    outcomes,
    inserted,
  });
}));
