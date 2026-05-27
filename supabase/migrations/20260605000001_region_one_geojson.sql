-- Single-region GeoJSON accessor for the /regions edit-page preview.
-- public.regions_map_geojson() returns the full collection; this is a per-id wrapper.

create or replace function public.region_one_geojson(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when r.geometry is null then null
    else jsonb_build_object(
      'type', 'Feature',
      'geometry', st_asgeojson(r.geometry::geometry)::jsonb,
      'properties', jsonb_build_object(
        'id', r.id,
        'name', r.name,
        'kind', r.kind
      )
    )
  end
  from public.regions r
  where r.id = p_id;
$$;

revoke all on function public.region_one_geojson(uuid) from public, anon;
grant execute on function public.region_one_geojson(uuid) to authenticated, service_role;
