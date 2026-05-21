-- Phase 2: region map GeoJSON RPC + 2-year retention cron

create or replace function public.regions_map_geojson()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'geometry', st_asgeojson(r.geometry::geometry)::jsonb,
          'properties', jsonb_build_object(
            'id', r.id,
            'name', r.name,
            'kind', r.kind,
            'subscriber_count', coalesce(c.cnt, 0)
          )
        )
        order by r.name
      ),
      '[]'::jsonb
    )
  )
  from public.regions r
  left join (
    select sr.region_id, count(*)::int as cnt
    from public.subscriber_regions sr
    join public.subscribers s on s.id = sr.subscriber_id and s.status = 'active'
    group by sr.region_id
  ) c on c.region_id = r.id
  where r.geometry is not null;
$$;

revoke all on function public.regions_map_geojson() from public, anon;
grant execute on function public.regions_map_geojson() to authenticated, service_role;

-- Weekly prune of rows older than 2 years (PLAN v4 retention).
select cron.unschedule('retention-prune-2yr') where exists (
  select 1 from cron.job where jobname = 'retention-prune-2yr'
);

select cron.schedule(
  'retention-prune-2yr',
  '0 3 * * 0',
  $$
  delete from public.external_delivery_logs where occurred_at < now() - interval '2 years';
  delete from public.delivery_logs where occurred_at < now() - interval '2 years';
  delete from public.replies where received_at < now() - interval '2 years';
  delete from public.nws_alerts where ingested_at < now() - interval '2 years';
  $$
);
