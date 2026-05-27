-- Debounce table for the health-monitor edge function. One row per
-- (function_name, condition) where condition ∈ {'failure_spike', 'stale'}.
-- The monitor reads + UPDATEs last_alerted_at on each tick so the operator
-- doesn't get hammered with the same DM every 5 minutes during a sustained
-- outage. Default debounce is 30 minutes (enforced in the monitor's code,
-- not via a CHECK constraint, so we can tune without DDL).
--
-- function_health() already exists from 20260606000001_function_runs.sql for
-- the /health dashboard view — the monitor queries function_runs directly
-- for the windowed-failure-rate signal it needs.

create table if not exists public.health_alerts (
  function_name    text not null,
  condition        text not null,
  last_alerted_at  timestamptz not null default now(),
  last_summary     text,
  primary key (function_name, condition)
);

alter table public.health_alerts enable row level security;

create policy "op health_alerts read"
  on public.health_alerts for select
  using (public.is_operator());

-- service_role bypasses RLS for monitor writes; no INSERT/UPDATE policy
-- needed.
