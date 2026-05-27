-- Stage 3b: GeoJSON RPC for cap_alerts polygons rendered on /radar.
-- Mirrors nws_alerts_radar_geojson but adapted for the CAP shape — no
-- effective/headline column, parsed_event substitutes for event, regions
-- substitutes for area_desc, no raw->geometry fallback (LibreWxR always
-- ships a Polygon in geometry when one exists).
--
-- Same Mid-South bbox scope as the NWS counterpart so both layers cover the
-- same map area. Wider scopes can be added later if the operator pans the
-- radar across CONUS frequently.

create or replace function public.cap_alerts_radar_geojson()
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
      ca.id,
      ca.uri,
      ca.parsed_event,
      ca.title,
      ca.severity,
      ca.regions,
      ca.expires_at,
      ca.status,
      st_asgeojson(ca.polygon::geometry)::jsonb as geometry
    from public.cap_alerts ca
    cross join midsouth m
    where ca.status in ('new', 'dispatched', 'skipped')
      and (ca.expires_at is null or ca.expires_at > now())
      and ca.polygon is not null
      and st_intersects(ca.polygon, m.g)
    order by ca.ingested_at desc
    limit 250
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
            'uri', w.uri,
            'parsed_event', w.parsed_event,
            'title', w.title,
            'severity', w.severity,
            'regions', w.regions,
            'expires_at', w.expires_at,
            'status', w.status
          )
        )
        order by w.parsed_event
      ),
      '[]'::jsonb
    )
  )
  from with_geom w;
$$;

revoke all on function public.cap_alerts_radar_geojson() from public, anon;
grant execute on function public.cap_alerts_radar_geojson() to authenticated, service_role;
