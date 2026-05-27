-- pg_cron: schedule cap-dispatcher every minute (mirrors nws-dispatcher
-- cadence). The function itself exits early when CAP_DISPATCHER_ENABLED!=1,
-- so this cron is inert until the operator flips the env flag.

select cron.schedule(
  'cap-dispatcher',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/cap-dispatcher',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
