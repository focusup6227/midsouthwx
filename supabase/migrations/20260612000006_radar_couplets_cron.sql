-- F9: schedule the couplet-poll edge function once per minute, and a
-- 6-hour retention prune every 15 min.
--
-- Cadence rationale: NEXRAD volume scans complete every 4–6 min in
-- precip-mode VCPs, and SAILS half-scans add a low-elevation refresh
-- every ~2 min. Polling once per minute means the worst-case latency
-- from a fresh volume landing in S3 to a track update on /radar is
-- ~1 min — fast enough that the operator's interactive use of the
-- radar feels live, without hammering the renderer (8 sites × 1 call/min
-- = 480 calls/hour, well inside its budget).
--
-- Retention is short on purpose: these detections are a real-time
-- situational signal. Anything older than 6 hours is just noise for the
-- live operator and would force the geojson RPC to scan more rows than
-- it ever needs to surface.

select cron.unschedule('couplet-poll') where exists (
  select 1 from cron.job where jobname = 'couplet-poll'
);

select cron.schedule(
  'couplet-poll',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/couplet-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

select cron.unschedule('radar-couplets-prune') where exists (
  select 1 from cron.job where jobname = 'radar-couplets-prune'
);

select cron.schedule(
  'radar-couplets-prune',
  '*/15 * * * *',
  $$
  delete from public.radar_couplets
  where volume_time_utc < now() - interval '6 hours';
  $$
);
