-- Schedule health-monitor every 5 min. Cadence matches the staleness floor
-- (the monitor's WINDOW_MIN is 15 so it sees three ticks of context per
-- run) and keeps the operator Telegram debounce (30 min) from feeling
-- twitchy if there's a flapping regression.

select cron.schedule(
  'health-monitor',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/health-monitor',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
