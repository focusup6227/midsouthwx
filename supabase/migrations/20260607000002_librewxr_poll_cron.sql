-- pg_cron: schedule librewxr-poll alongside nws-poll. Same cadence (1/min)
-- so cap_alerts stays in sync with nws_alerts for side-by-side comparison.
--
-- librewxr-poll does not self-reinvoke (unlike nws-poll's 30s follow-up),
-- so effective rate is 1/min. Tune up later if LibreWxR's freshness lags.

select cron.schedule(
  'librewxr-poll',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/librewxr-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
