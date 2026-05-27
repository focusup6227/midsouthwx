-- F9 (extension): schedule couplet-dispatcher every minute, offset 30s
-- from couplet-poll so the dispatcher reads the freshest detections.
-- pg_cron can't sub-minute, so we get :00 (poll) → :30 (dispatcher) only
-- approximately — the offset comes from couplet-poll's typical 30-60s
-- runtime, not a separate schedule. Close enough for shadow mode; live
-- mode can revisit if we need tighter coupling.

select cron.unschedule('couplet-dispatcher') where exists (
  select 1 from cron.job where jobname = 'couplet-dispatcher'
);

select cron.schedule(
  'couplet-dispatcher',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/couplet-dispatcher',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Retention prune: drop couplet_alerts rows older than 30 days every
-- 6 hours. Keeps the table small enough that the analysis queries on
-- /radar and /health stay cheap.
select cron.unschedule('couplet-alerts-prune') where exists (
  select 1 from cron.job where jobname = 'couplet-alerts-prune'
);

select cron.schedule(
  'couplet-alerts-prune',
  '17 */6 * * *',
  $$
  select public.prune_couplet_alerts();
  $$
);
