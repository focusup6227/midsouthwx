-- Single-shot status-count rollup for /nws filter chips.
--
-- Previously the page issued 6 sequential `count: 'exact', head: true`
-- queries against nws_alerts (one per status enum value). Under active
-- severe-weather load that's 6 round trips on every SSR. This RPC does
-- the grouping in one statement and returns the rollup as a small
-- result set so the dashboard pays for exactly one query.

create or replace function public.nws_status_counts()
returns table(status text, count integer)
language sql
stable
security invoker
set search_path = public
as $$
  with statuses as (
    select unnest(enum_range(null::public.nws_status))::text as status
  )
  select
    s.status,
    coalesce((
      select count(*)::int
      from public.nws_alerts a
      where a.status::text = s.status
    ), 0) as count
  from statuses s;
$$;

revoke all on function public.nws_status_counts() from public, anon;
grant execute on function public.nws_status_counts() to authenticated, service_role;
