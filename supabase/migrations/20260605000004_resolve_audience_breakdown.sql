-- resolve_audience_breakdown(spec): per-state count of subscribers matched
-- by resolve_audience(spec). Replaces the radar client's old hardcoded
-- substring match against subscriber display names (Memphis/TN/MS/...) with
-- the actual state derived from subscribers.county_fips (first two digits =
-- state FIPS). Used by the radar selection panel's audience breakdown.

create or replace function public.resolve_audience_breakdown(spec jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with sids as (
    select subscriber_id from public.resolve_audience(spec)
  ),
  per_sub as (
    select substring(coalesce(s.county_fips, ''), 1, 2) as state_fips
    from public.subscribers s
    where s.id in (select subscriber_id from sids)
  )
  select jsonb_build_object(
    'total', (select count(*) from per_sub),
    'tn',    (select count(*) from per_sub where state_fips = '47'),
    'ms',    (select count(*) from per_sub where state_fips = '28'),
    'ar',    (select count(*) from per_sub where state_fips = '05'),
    'other', (select count(*) from per_sub
              where state_fips not in ('47','28','05') or state_fips = '')
  );
$$;

revoke all on function public.resolve_audience_breakdown(jsonb) from public, anon;
grant execute on function public.resolve_audience_breakdown(jsonb)
  to authenticated, service_role;
