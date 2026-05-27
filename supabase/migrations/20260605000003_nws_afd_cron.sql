-- afd-poll: pull each Mid-South WFO's latest AFD every 30 minutes.
-- WFOs publish AFDs ~4×/day; 30 min cadence catches updates without
-- thrashing api.weather.gov. Matches the spc-poll cadence and pattern.

select cron.schedule(
  'nws-afd-poll',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/afd-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
