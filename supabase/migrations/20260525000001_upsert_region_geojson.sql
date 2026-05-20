-- Server-side helper for the regions admin UI + import script.
-- Accepts GeoJSON as text, validates, snaps to MultiPolygon, casts to geography(MultiPolygon,4326).
-- Upserts on county_fips (kind='county') or ugc_code (kind='zone'); inserts a new row otherwise.
-- The regions_after_change trigger (in 20260518000002_subscribers.sql) reruns subscriber matching.

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

-- Mirror as a public schema wrapper so PostgREST can call it via .rpc('upsert_region_geojson').
-- Service_role-only so the admin path stays gated; the operator UI uses supabaseAdmin().
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
