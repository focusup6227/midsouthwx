-- Subscriber locations as GeoJSON for the radar map.
-- supabase-js returns geography columns as WKB hex strings by default; calling
-- ST_AsGeoJSON here means the route gets a usable FeatureCollection directly.

create or replace function public.subscriber_locations_geojson()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'geometry', st_asgeojson(s.location::geometry)::jsonb,
          'properties', jsonb_build_object(
            'id', s.id,
            'name', s.display_name,
            'zip', s.zip,
            'county_fips', s.county_fips,
            'home_address', s.home_address,
            'current_address', s.current_address,
            'telegram_username', s.telegram_username
          )
        )
      ),
      '[]'::jsonb
    )
  )
  from public.subscribers s
  where s.status = 'active'
    and s.location is not null;
$$;

revoke all on function public.subscriber_locations_geojson() from public, anon;
grant execute on function public.subscriber_locations_geojson() to authenticated, service_role;
