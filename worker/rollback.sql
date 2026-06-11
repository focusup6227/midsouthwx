-- Rollback of worker/cutover.sql: restore the pg_cron → Edge Function
-- schedules exactly as the migrations left them (none of them attach the
-- optional CRON_INVOKER_JWT header). Safe to run while the worker is still
-- up — every claim path uses FOR UPDATE SKIP LOCKED and the upserts are
-- idempotent — but stop the worker (`fly scale count 0`) promptly to avoid
-- doubled polling load.

do $do$
declare
  j record;
begin
  for j in
    select *
    from (values
      ('send-worker',          '* * * * *',    'telegram-send-worker'),
      ('scheduled-dispatcher', '* * * * *',    'scheduled-dispatcher'),
      ('nws-poll',             '* * * * *',    'nws-poll'),
      ('nws-dispatcher',       '* * * * *',    'nws-dispatcher'),
      ('lsr-poll',             '*/5 * * * *',  'lsr-poll'),
      ('spc-poll',             '*/30 * * * *', 'spc-poll'),
      ('nws-afd-poll',         '*/30 * * * *', 'afd-poll'),
      ('librewxr-poll',        '* * * * *',    'librewxr-poll'),
      ('cap-dispatcher',       '* * * * *',    'cap-dispatcher'),
      ('health-monitor',       '*/5 * * * *',  'health-monitor'),
      ('event-recap',          '*/5 * * * *',  'event-recap'),
      ('couplet-poll',         '* * * * *',    'couplet-poll'),
      ('couplet-dispatcher',   '* * * * *',    'couplet-dispatcher'),
      ('daily-forecast',       '15 12 * * *',  'daily-forecast')
    ) as t(jobname, sched, fn)
  loop
    perform cron.unschedule(j.jobname)
    where exists (select 1 from cron.job where jobname = j.jobname);
    perform cron.schedule(
      j.jobname,
      j.sched,
      format(
        $$select net.http_post(
          url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/%s',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body := '{}'::jsonb
        );$$,
        j.fn
      )
    );
  end loop;
end
$do$;

select jobname, schedule from cron.job order by jobname;
