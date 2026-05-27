-- Radar map: active NWS polygons as GeoJSON (geography → WKB in PostgREST otherwise).

create or replace function public.nws_alerts_radar_geojson()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with midsouth as (
    select st_setsrid(st_makeenvelope(-93.5, 32.8, -82.0, 37.5, 4326), 4326)::geography as g
  ),
  active as (
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
    cross join midsouth m
    where na.status in ('new', 'dispatched')
      and (na.expires_at is null or na.expires_at > now())
      and (
        (na.polygon is not null and st_intersects(na.polygon, m.g))
        or (
          na.polygon is null
          and na.raw->'geometry' is not null
          and na.raw->'geometry' != 'null'::jsonb
          and (na.raw#>>'{geometry,type}') in ('Polygon', 'MultiPolygon')
        )
      )
    order by na.ingested_at desc
    limit 150
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
