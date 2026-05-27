-- The cron.schedule call in 20260613000003 silently no-op'd during the
-- platform stress that night — the job never landed in cron.job. Re-issue
-- it idempotently here. Uses a do-block instead of `select ... where exists`
-- so the unschedule is guaranteed to skip when the row is absent, no matter
-- how the planner treats the volatile function call.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'couplet-dispatcher') then
    perform cron.unschedule('couplet-dispatcher');
  end if;
end $$;

select cron.schedule(
  'couplet-dispatcher',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/couplet-dispatcher',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $cron$
);
