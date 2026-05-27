-- Schedule event-recap every 5 min. The function reads alerts whose
-- expires_at landed 2+ min ago, so a 5-min cadence ensures any expired
-- alert hits the recap path within ~10 min of going inactive — fast
-- enough to feel timely without competing for the worker batch slot.

select cron.schedule(
  'event-recap',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/event-recap',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
