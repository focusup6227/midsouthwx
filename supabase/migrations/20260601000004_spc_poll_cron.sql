-- F7: schedule spc-poll every 30 minutes. SPC issues Day 1 outlooks at
-- 1200, 1300, 1630, 2000, and 0100 UTC; Day 2/3 once a day; a 30-min
-- cadence picks up every new issuance within 30 min of publish without
-- hammering spc.noaa.gov.

select cron.unschedule('spc-poll') where exists (
  select 1 from cron.job where jobname = 'spc-poll'
);

select cron.schedule(
  'spc-poll',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/spc-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
