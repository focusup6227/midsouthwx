-- NWS alert retention: mark past-due rows expired, prune after 90 days.
-- (Other tables still use retention-prune-2yr weekly job.)

select cron.unschedule('retention-prune-2yr') where exists (
  select 1 from cron.job where jobname = 'retention-prune-2yr'
);

select cron.schedule(
  'retention-prune-2yr',
  '0 3 * * 0',
  $$
  delete from public.external_delivery_logs where occurred_at < now() - interval '2 years';
  delete from public.delivery_logs where occurred_at < now() - interval '2 years';
  delete from public.replies where received_at < now() - interval '2 years';
  $$
);

select cron.unschedule('nws-alerts-prune') where exists (
  select 1 from cron.job where jobname = 'nws-alerts-prune'
);

select cron.schedule(
  'nws-alerts-prune',
  '15 3 * * *',
  $$
  update public.nws_alerts
  set status = 'expired'
  where expires_at is not null
    and expires_at < now()
    and status = 'new';

  delete from public.nws_alerts
  where ingested_at < now() - interval '90 days';
  $$
);
