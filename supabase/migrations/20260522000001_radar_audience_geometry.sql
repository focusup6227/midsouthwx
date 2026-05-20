-- Extend resolve_audience to support geometry selection (for radar area alerts)
-- Supports:
--   {"geometry": {"type": "circle", "center": [lon, lat], "radius_km": r}}
--   {"geometry": {"type": "Polygon"|"MultiPolygon", "coordinates": [...]}}  -- raw GeoJSON geometry
-- Combines with other filters (regions/groups/etc) via OR; de-duped by DISTINCT.

create or replace function public.resolve_audience(spec jsonb)
returns table(subscriber_id uuid)
language sql
stable
as $$
  with
    explicit_subs as (
      select (value)::uuid as id
      from jsonb_array_elements_text(coalesce(spec->'subscribers', '[]'::jsonb))
    ),
    region_ids as (
      select (value)::uuid as id
      from jsonb_array_elements_text(coalesce(spec->'regions', '[]'::jsonb))
    ),
    group_ids as (
      select (value)::uuid as id
      from jsonb_array_elements_text(coalesce(spec->'groups', '[]'::jsonb))
    )
  select distinct s.id
  from public.subscribers s
  where s.status = 'active'
    and (
      coalesce((spec->>'all')::boolean, false) = true
      or s.id in (select id from explicit_subs)
      or exists (
        select 1 from public.subscriber_regions sr
        where sr.subscriber_id = s.id and sr.region_id in (select id from region_ids)
      )
      or exists (
        select 1 from public.group_memberships gm
        where gm.subscriber_id = s.id and gm.group_id in (select id from group_ids)
      )
      or (
        spec ? 'geometry'
        and s.location is not null
        and (
          -- Circle: center [lon,lat], radius_km
          (
            lower(coalesce(spec->'geometry'->>'type','')) = 'circle'
            and st_dwithin(
              s.location,
              st_setsrid(st_makepoint(
                (spec->'geometry'->'center'->>0)::double precision,
                (spec->'geometry'->'center'->>1)::double precision
              ), 4326)::geography,
              (coalesce((spec->'geometry'->>'radius_km')::double precision, 0) * 1000.0)
            )
          )
          or
          -- GeoJSON geometry (Polygon/MultiPolygon etc.)
          (
            lower(coalesce(spec->'geometry'->>'type','')) in ('polygon','multipolygon')
            and st_intersects(
              s.location,
              st_geomfromgeojson(spec->'geometry')::geography
            )
          )
        )
      )
    );
$$;

revoke all on function public.resolve_audience(jsonb) from public, anon;
grant execute on function public.resolve_audience(jsonb) to authenticated, service_role;
