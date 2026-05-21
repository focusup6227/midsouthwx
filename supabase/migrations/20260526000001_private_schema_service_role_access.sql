-- Fix two latent bugs that block service_role from inserting subscribers/regions:
--
-- 1. `private.sub_regions_trigger` / `private.regions_trigger` /
--    `private.scheduled_messages_default_next_run` are SECURITY INVOKER. When
--    service_role inserts into public.subscribers / public.regions /
--    public.scheduled_messages, these triggers fire as service_role, which has
--    no USAGE on `private`, so the trigger function call itself is rejected
--    with `permission denied for schema private` (SQLSTATE 42501).
--
-- 2. The repo's earlier `upsert_region_geojson` migration may not have been
--    applied on remote. Reapply it here so the regions admin UI + import
--    script always have a public wrapper to call.
--
-- Fix strategy: make the trigger functions SECURITY DEFINER so they run as
-- their owner (postgres), grant USAGE + EXECUTE to service_role as a
-- belt-and-suspenders measure, and ensure the upsert helper exists.

grant usage on schema private to service_role;
grant execute on all functions in schema private to service_role;
alter default privileges in schema private
  grant execute on functions to service_role;

create or replace function private.sub_regions_trigger() returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform private.refresh_subscriber_regions(new.id);
  return new;
end$$;

create or replace function private.regions_trigger() returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform private.rebuild_region_memberships(new.id);
  return new;
end$$;

create or replace function private.scheduled_messages_default_next_run()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' and new.next_run_at is null then
      new.next_run_at := new.scheduled_for;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'pending'
       and (
         new.scheduled_for is distinct from old.scheduled_for
         or new.rrule is distinct from old.rrule
       ) then
      new.next_run_at := new.scheduled_for;
      new.dispatch_attempts := 0;
      new.last_error := null;
    end if;
  end if;
  return new;
end$$;

-- Reapply 20260525000001 contents (idempotent via create or replace).
create or replace function private.upsert_region_geojson(
  p_name        text,
  p_kind        text,
  p_county_fips text,
  p_ugc_code    text,
  p_geojson     text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id   uuid;
  v_geom geography(MultiPolygon, 4326);
  v_fips text := nullif(p_county_fips, '');
  v_ugc  text := nullif(p_ugc_code, '');
begin
  if p_kind not in ('county', 'zone', 'custom_polygon') then
    raise exception 'invalid kind: %', p_kind;
  end if;

  if p_geojson is not null and p_geojson <> '' then
    v_geom := ST_Multi(
                ST_MakeValid(
                  ST_SetSRID(ST_GeomFromGeoJSON(p_geojson), 4326)
                )
              )::geography;
  end if;

  if p_kind = 'county' and v_fips is not null then
    insert into public.regions (name, kind, county_fips, ugc_code, geometry)
    values (p_name, p_kind, v_fips, v_ugc, v_geom)
    on conflict (county_fips) where county_fips is not null
      do update set
        name     = excluded.name,
        kind     = excluded.kind,
        ugc_code = coalesce(excluded.ugc_code, public.regions.ugc_code),
        geometry = coalesce(excluded.geometry, public.regions.geometry)
    returning id into v_id;
  elsif p_kind = 'zone' and v_ugc is not null then
    insert into public.regions (name, kind, county_fips, ugc_code, geometry)
    values (p_name, p_kind, v_fips, v_ugc, v_geom)
    on conflict (ugc_code) where ugc_code is not null
      do update set
        name        = excluded.name,
        kind        = excluded.kind,
        county_fips = coalesce(excluded.county_fips, public.regions.county_fips),
        geometry    = coalesce(excluded.geometry, public.regions.geometry)
    returning id into v_id;
  else
    insert into public.regions (name, kind, county_fips, ugc_code, geometry)
    values (p_name, p_kind, v_fips, v_ugc, v_geom)
    returning id into v_id;
  end if;

  return v_id;
end$$;

revoke all on function private.upsert_region_geojson(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function private.upsert_region_geojson(text, text, text, text, text)
  to service_role;

create or replace function public.upsert_region_geojson(
  p_name        text,
  p_kind        text,
  p_county_fips text,
  p_ugc_code    text,
  p_geojson     text
) returns uuid
language sql
security definer
set search_path = public, extensions
as $$
  select private.upsert_region_geojson(p_name, p_kind, p_county_fips, p_ugc_code, p_geojson);
$$;

revoke all on function public.upsert_region_geojson(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_region_geojson(text, text, text, text, text)
  to service_role;
