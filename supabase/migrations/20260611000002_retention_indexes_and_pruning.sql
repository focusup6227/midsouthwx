-- Two retention/perf fixes that surfaced under load review:
--
--  1. delivery_logs is one of the fastest-growing tables (one row per send
--     event per subscriber). The existing weekly retention-prune-2yr cron
--     runs `where occurred_at < now() - interval '2 years'` against it,
--     and `delivery_logs_msg_idx (message_id, occurred_at desc)` doesn't
--     help that scan because the leading column is message_id. Add a
--     dedicated index on occurred_at so the prune (and any time-window
--     analytics) doesn't full-scan the largest table.
--
--  2. outbound_queue had no retention. Rows in terminal status (sent,
--     skipped, failed) live forever, growing the table and slowing every
--     scan including the worker's `claim_outbound_batch`. Add the prune to
--     the existing weekly job. 90 days is plenty of breathing room for
--     post-event audit (delivery_logs keep 2 years anyway).

create index if not exists delivery_logs_occurred_at_idx
  on public.delivery_logs (occurred_at);

-- Recreate the weekly retention job so the outbound_queue prune ships
-- alongside the existing prunes in one transaction. Same cadence (Sundays
-- 03:00 UTC) and same scope as before, plus the new outbound_queue line.
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
  delete from public.outbound_queue
    where status in ('sent', 'skipped', 'failed')
      and created_at < now() - interval '90 days';
  $$
);
