-- F4: schedule lsr-poll to run every 5 minutes. Mirrors the existing
-- nws-poll cron pattern (see 20260526000004_repair_send_worker_cron.sql).
-- 5-minute cadence is comfortably below the IEM endpoint's expected polling
-- envelope and is fast enough that a fresh tornado LSR appears on /radar
-- within ~5 min of the spotter call.

select cron.unschedule('lsr-poll') where exists (
  select 1 from cron.job where jobname = 'lsr-poll'
);

select cron.schedule(
  'lsr-poll',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/lsr-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
