-- Re-install pg_cron jobs that may not exist on the remote.
--
-- We've observed Tyler's outbound_queue rows sitting `pending` for minutes at
-- a time, never picked up by the worker, despite the cron migration from
-- 20260518000007 supposedly scheduling it every minute. The NWS crons fire
-- on schedule (proving pg_cron + pg_net both work), so the send-worker cron
-- was either never created or got unscheduled.
--
-- This migration is idempotent: it unschedules anything with the matching
-- jobname (returns null if not present) and re-creates it. Run it any time
-- you suspect a worker has stopped firing on schedule.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- send-worker (drains outbound_queue, ~25 msg/s)
select cron.unschedule('send-worker') where exists (
  select 1 from cron.job where jobname = 'send-worker'
);
select cron.schedule(
  'send-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/telegram-send-worker',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- scheduled-dispatcher (RRULE-driven repeating messages → outbound_queue)
select cron.unschedule('scheduled-dispatcher') where exists (
  select 1 from cron.job where jobname = 'scheduled-dispatcher'
);
select cron.schedule(
  'scheduled-dispatcher',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/scheduled-dispatcher',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- nws-poll (api.weather.gov/alerts/active → nws_alerts)
select cron.unschedule('nws-poll') where exists (
  select 1 from cron.job where jobname = 'nws-poll'
);
select cron.schedule(
  'nws-poll',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/nws-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- nws-dispatcher (auto_alert_rules → messages/outbound_queue or pending_approval)
select cron.unschedule('nws-dispatcher') where exists (
  select 1 from cron.job where jobname = 'nws-dispatcher'
);
select cron.schedule(
  'nws-dispatcher',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/nws-dispatcher',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Verification: should print 4+ jobs (send-worker, scheduled-dispatcher,
-- nws-poll, nws-dispatcher, plus any existing daily prunes).
select jobid, jobname, schedule, active from cron.job order by jobname;
