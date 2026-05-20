-- Invoke scheduled-dispatcher every minute (same pg_net pattern as send-worker).

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
