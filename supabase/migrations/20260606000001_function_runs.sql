-- Edge-function health telemetry. Every cron-driven function writes one row
-- per invocation via log_function_run(). The /health dashboard reads
-- function_health() for rolled-up status and outbound_queue_depth() for the
-- worker-side queue lag.

create table public.function_runs (
  id            bigserial primary key,
  function_name text not null,
  fired_at      timestamptz not null default now(),
  duration_ms   integer,
  ok            boolean not null,
  result        jsonb,
  error         text
);

create index function_runs_name_fired_idx
  on public.function_runs (function_name, fired_at desc);

create index function_runs_fired_idx
  on public.function_runs (fired_at desc);

alter table public.function_runs enable row level security;

create policy "op function_runs_select"
  on public.function_runs for select
  using (public.is_operator());

-- Service-role-only writer used by the edge function wrapper. SECURITY DEFINER
-- so the call works even when the function runs with a JWT that doesn't have
-- direct insert privileges (e.g. when invoked by Supabase Realtime / cron).
create or replace function public.log_function_run(
  p_name        text,
  p_ok          boolean,
  p_duration_ms integer,
  p_result      jsonb default null,
  p_error       text default null
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.function_runs (function_name, ok, duration_ms, result, error)
  values (p_name, p_ok, p_duration_ms, p_result, p_error);
$$;

revoke all on function public.log_function_run(text, boolean, integer, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.log_function_run(text, boolean, integer, jsonb, text)
  to service_role;

-- Rolled-up status per function across the last 24h. Driven by the dashboard.
create or replace function public.function_health()
returns table(
  function_name      text,
  last_fired_at      timestamptz,
  last_success_at    timestamptz,
  last_failure_at    timestamptz,
  last_error         text,
  runs_24h           integer,
  failures_24h       integer,
  avg_duration_ms    integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with by_name as (
    select function_name
    from public.function_runs
    where fired_at > now() - interval '24 hours'
    group by function_name
  ),
  recent as (
    select * from public.function_runs
    where fired_at > now() - interval '24 hours'
  )
  select
    b.function_name,
    (select max(fired_at) from recent r where r.function_name = b.function_name) as last_fired_at,
    (select max(fired_at) from recent r where r.function_name = b.function_name and r.ok)        as last_success_at,
    (select max(fired_at) from recent r where r.function_name = b.function_name and not r.ok)    as last_failure_at,
    (select error from recent r where r.function_name = b.function_name and not r.ok order by fired_at desc limit 1) as last_error,
    (select count(*)::int from recent r where r.function_name = b.function_name) as runs_24h,
    (select count(*)::int from recent r where r.function_name = b.function_name and not r.ok) as failures_24h,
    (select avg(duration_ms)::int from recent r where r.function_name = b.function_name) as avg_duration_ms
  from by_name b
  order by b.function_name;
$$;

revoke all on function public.function_health() from public, anon;
grant execute on function public.function_health() to authenticated, service_role;

-- Outbound queue depth split by status so the dashboard can call out backlogs.
create or replace function public.outbound_queue_depth()
returns table(
  status       text,
  count        integer,
  oldest_at    timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    status::text,
    count(*)::int as count,
    min(created_at) as oldest_at
  from public.outbound_queue
  group by status;
$$;

revoke all on function public.outbound_queue_depth() from public, anon;
grant execute on function public.outbound_queue_depth() to authenticated, service_role;

-- Read-side view onto cron.job for the dashboard. cron schema isn't exposed
-- via PostgREST and operators don't have direct SELECT on it; this wrapper
-- filters down to just the metadata the /health page needs.
create or replace function public.cron_jobs_listing()
returns table(
  jobname  text,
  schedule text,
  active   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select jobname::text, schedule::text, active
  from cron.job
  order by jobname;
$$;

revoke all on function public.cron_jobs_listing() from public, anon;
grant execute on function public.cron_jobs_listing() to authenticated, service_role;

-- Weekly prune of run history >7d. The dashboard only reads the last 24h.
select cron.schedule(
  'function-runs-prune',
  '5 4 * * *',
  $$ delete from public.function_runs where fired_at < now() - interval '7 days'; $$
);
