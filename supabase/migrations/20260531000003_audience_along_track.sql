-- F3 (storm-track impact projection): "who is in this storm's projected
-- path?" using the NWS forecast LineString as the spine of a corridor and
-- ST_DWithin for the swept-buffer test.
--
-- Two surfaces:
--   1. resolve_audience_along_track(line, km) — direct RPC used by the
--      radar inspector to render the in-path count without re-buffering
--      client-side.
--   2. resolve_audience(spec) extended with geometry.type = 'track' so the
--      /compose preview + fan-out paths (which both call resolve_audience
--      with the same spec) can target the corridor without a special case.
--
-- ST_DWithin against a geography reference is index-friendly and avoids
-- materializing a full buffered polygon — same semantics as
-- ST_Intersects(ST_Buffer(line)) but cheaper.

create or replace function public.resolve_audience_along_track(
  p_line jsonb,
  p_corridor_km double precision
)
returns table(subscriber_id uuid)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select s.id
  from public.subscribers s
  where s.status = 'active'
    and s.location is not null
    and p_line ? 'type'
    and lower(coalesce(p_line->>'type', '')) = 'linestring'
    and st_dwithin(
      s.location,
      st_geomfromgeojson(p_line)::geography,
      greatest(coalesce(p_corridor_km, 0), 0) * 1000.0
    );
$$;

revoke all on function public.resolve_audience_along_track(jsonb, double precision)
  from public, anon;
grant execute on function public.resolve_audience_along_track(jsonb, double precision)
  to authenticated, service_role;

-- Extend resolve_audience with the 'track' geometry kind. Keeps the existing
-- 'circle' / 'Polygon' / 'MultiPolygon' branches intact so the radar draw
-- flow + region-based sends keep working untouched.
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
          -- GeoJSON polygon (Polygon/MultiPolygon)
          (
            lower(coalesce(spec->'geometry'->>'type','')) in ('polygon','multipolygon')
            and st_intersects(
              s.location,
              st_geomfromgeojson(spec->'geometry')::geography
            )
          )
          or
          -- F3: track corridor (storm forecast path). geometry shape:
          --   {"type":"track","line":<LineString>,"corridor_km":<float>}
          (
            lower(coalesce(spec->'geometry'->>'type','')) = 'track'
            and (spec->'geometry'->'line') is not null
            and lower(coalesce(spec->'geometry'->'line'->>'type','')) = 'linestring'
            and st_dwithin(
              s.location,
              st_geomfromgeojson(spec->'geometry'->'line')::geography,
              greatest(coalesce((spec->'geometry'->>'corridor_km')::double precision, 0), 0) * 1000.0
            )
          )
        )
      )
    );
$$;

revoke all on function public.resolve_audience(jsonb) from public, anon;
grant execute on function public.resolve_audience(jsonb) to authenticated, service_role;
