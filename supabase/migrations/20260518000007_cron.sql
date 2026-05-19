-- 0007 — schedule the send-worker via pg_cron.
-- Edit the project_ref below to match your Supabase project before applying.

-- Note: project_ref is hardcoded here. If you migrate to a new project, update
-- this migration's URL and re-apply (or unschedule + re-schedule the job).

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
