-- Live event mode plumbing for /radar:
--   1. Realtime publication on telegram_storm_reports so new pins push to
--      the radar map + chime in StormReportAudio.
--   2. recent_storm_report_clusters() RPC for the pulsing 5 km ring overlay.
--      Returns one polygon per active cluster (cluster_paged_at within the
--      last p_minutes), built from the union of report points buffered to
--      ~5 km so we don't over-trust a single noisy outlier.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'telegram_storm_reports'
  ) then
    execute 'alter publication supabase_realtime add table public.telegram_storm_reports';
  end if;
end$$;

create or replace function public.recent_storm_report_clusters(p_minutes integer default 30)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with paged as (
    select id, hazard, lat, lon, point, cluster_paged_at
    from public.telegram_storm_reports
    where cluster_paged_at is not null
      and cluster_paged_at >= now() - make_interval(mins => greatest(coalesce(p_minutes, 30), 1))
  ),
  -- Group rows that are within 5 km AND share a hazard into a cluster
  -- bucket. We grab the earliest cluster_paged_at in the bucket and use it
  -- as the cluster's "fired" timestamp, then build the centroid + count.
  clusters as (
    select
      hazard,
      avg(lat) as centroid_lat,
      avg(lon) as centroid_lon,
      st_centroid(st_collect(point::geometry))::geography as centroid,
      min(cluster_paged_at) as fired_at,
      count(*)::int as size,
      array_agg(id) as report_ids
    from (
      -- Self-join to find nearby rows of same hazard, then collapse via a
      -- representative row (min id). Cheap given how few reports we have
      -- in a 30-min window in practice.
      select
        a.id, a.hazard, a.lat, a.lon, a.point, a.cluster_paged_at,
        (
          select min(b.id::text)::uuid
          from paged b
          where b.hazard = a.hazard
            and st_dwithin(a.point, b.point, 5000)
        ) as rep_id
      from paged a
    ) g
    group by hazard, rep_id
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'geometry', jsonb_build_object(
            'type', 'Point',
            'coordinates', jsonb_build_array(centroid_lon, centroid_lat)
          ),
          'properties', jsonb_build_object(
            'hazard', hazard,
            'size', size,
            'fired_at', fired_at,
            'report_ids', report_ids
          )
        )
        order by fired_at desc
      ),
      '[]'::jsonb
    )
  )
  from clusters
  where size >= 2;
$$;

revoke all on function public.recent_storm_report_clusters(integer) from public, anon;
grant execute on function public.recent_storm_report_clusters(integer) to authenticated, service_role;
