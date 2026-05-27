-- Stage 2: dispatcher RPCs for cap_alerts. Mirrors the nws_* trio
-- (claim_nws_alert_batch / nws_alert_audience / nws_finish_dispatch) but
-- adapted for the CAP shape.
--
-- Key behavioral diff: LibreWxR's CAP feed has no UGC zones, no SAME codes,
-- and `regions` is a freeform string. So audience resolution is polygon-only.
-- If a CAP alert ships without a polygon, it has no audience and the
-- dispatcher will mark it 'skipped'. That's acceptable — the existing NWS
-- pipeline still catches polygon-less alerts via UGC/SAME matching.

-- Atomically claim cap_alerts pending dispatch (status = new).
create or replace function public.claim_cap_alert_batch(
  p_limit int,
  p_locked_by text,
  p_lock_ttl_sec int
)
returns table (
  id uuid,
  uri text,
  parsed_event text,
  title text,
  severity text,
  description text,
  regions text,
  expires_at timestamptz,
  raw jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  return query
  with claimable as (
    select ca.id
    from public.cap_alerts ca
    where ca.status = 'new'
      and (ca.locked_at is null or ca.locked_at < v_now - make_interval(secs => p_lock_ttl_sec))
    order by ca.ingested_at
    limit p_limit
    for update of ca skip locked
  ),
  claimed as (
    update public.cap_alerts ca
    set locked_at = v_now,
        locked_by = p_locked_by
    from claimable c
    where ca.id = c.id
    returning
      ca.id,
      ca.uri,
      ca.parsed_event,
      ca.title,
      ca.severity,
      ca.description,
      ca.regions,
      ca.expires_at,
      ca.raw
  )
  select * from claimed;
end$$;

revoke all on function public.claim_cap_alert_batch(int, text, int) from public;
revoke all on function public.claim_cap_alert_batch(int, text, int) from anon, authenticated;
grant execute on function public.claim_cap_alert_batch(int, text, int) to service_role;

-- Polygon-only audience. Optional region_filter narrows to subscribers in
-- a specific set of operator-managed regions (same JSONB shape as
-- nws_alert_audience's region_filter for consistency).
create or replace function public.cap_alert_audience(
  p_alert_id uuid,
  p_region_filter jsonb default null
)
returns table (subscriber_id uuid)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with a as (
    select *
    from public.cap_alerts
    where id = p_alert_id
  ),
  region_ids as (
    select r::uuid as id
    from jsonb_array_elements_text(coalesce(p_region_filter->'region_ids', '[]'::jsonb)) as r
    where coalesce(jsonb_array_length(coalesce(p_region_filter->'region_ids', '[]'::jsonb)), 0) > 0
  ),
  geo_matched as (
    select distinct s.id as sid
    from public.subscribers s
    cross join a
    where s.status = 'active'
      and a.polygon is not null
      and s.location is not null
      and st_intersects(s.location, a.polygon)
  ),
  filtered as (
    select g.sid
    from geo_matched g
    where not exists (select 1 from region_ids limit 1)
       or exists (
         select 1
         from public.subscriber_regions sr
         join region_ids ri on sr.region_id = ri.id
         where sr.subscriber_id = g.sid
       )
  )
  select f.sid as subscriber_id from filtered f;
$$;

revoke all on function public.cap_alert_audience(uuid, jsonb) from public;
revoke all on function public.cap_alert_audience(uuid, jsonb) from anon, authenticated;
grant execute on function public.cap_alert_audience(uuid, jsonb) to service_role;

create or replace function public.cap_finish_dispatch(
  p_alert_id uuid,
  p_status public.nws_status
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.cap_alerts
  set status = p_status,
      locked_at = null,
      locked_by = null
  where id = p_alert_id;
end$$;

revoke all on function public.cap_finish_dispatch(uuid, public.nws_status) from public;
revoke all on function public.cap_finish_dispatch(uuid, public.nws_status) from anon, authenticated;
grant execute on function public.cap_finish_dispatch(uuid, public.nws_status) to service_role;
