-- Restore 'skipped' to the radar GeoJSON status filter.
--
-- 20260606000002_radar_include_skipped.sql intentionally added 'skipped' so
-- Special Weather Statements (e.g. hail SWSes for south MS) would paint on
-- the map even though the dispatcher chose not to broadcast them. The next
-- day's 20260607000008_widen_radar_geojson.sql dropped the Mid-South bbox
-- and bumped the limit to 500 — but its replacement function omitted
-- 'skipped' from the status list, undoing the 06-06 fix. This restores it
-- while keeping the nationwide scope + 500-row limit.

create or replace function public.nws_alerts_radar_geojson()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with active as (
    select
      na.id,
      na.nws_id,
      na.event,
      na.severity,
      na.headline,
      na.area_desc,
      na.expires_at,
      na.effective,
      na.status,
      coalesce(
        case when na.polygon is not null then st_asgeojson(na.polygon::geometry)::jsonb end,
        case
          when na.raw->'geometry' is not null and na.raw->'geometry' != 'null'::jsonb
          then na.raw->'geometry'
        end
      ) as geometry
    from public.nws_alerts na
    where na.status in ('new', 'dispatched', 'skipped')
      and (na.expires_at is null or na.expires_at > now())
      and (
        na.polygon is not null
        or (
          na.raw->'geometry' is not null
          and na.raw->'geometry' != 'null'::jsonb
          and (na.raw#>>'{geometry,type}') in ('Polygon', 'MultiPolygon')
        )
      )
    order by na.ingested_at desc
    limit 500
  ),
  with_geom as (
    select *
    from active
    where geometry is not null
      and (geometry->>'type') in ('Polygon', 'MultiPolygon')
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'id', w.id::text,
          'geometry', w.geometry,
          'properties', jsonb_build_object(
            'id', w.id,
            'nws_id', w.nws_id,
            'event', w.event,
            'severity', w.severity,
            'headline', w.headline,
            'area_desc', w.area_desc,
            'expires_at', w.expires_at,
            'effective', w.effective,
            'status', w.status
          )
        )
        order by w.event
      ),
      '[]'::jsonb
    )
  )
  from with_geom w;
$$;

revoke all on function public.nws_alerts_radar_geojson() from public, anon;
grant execute on function public.nws_alerts_radar_geojson() to authenticated, service_role;
