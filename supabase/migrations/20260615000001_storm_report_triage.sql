-- Storm-report triage workflow + cluster detection + place-name field.
--
-- Extends telegram_storm_reports with:
--   - status ∈ {new, verified, dismissed, promoted} so the operator can
--     triage reports from /reports without deleting them.
--   - place_name: reverse-geocoded relative location ("3 NE Bartlett, TN")
--     filled at submit time by the webhook from api.weather.gov/points.
--   - cluster_paged_at: stamped when this report is part of an
--     auto-paged cluster (≥2 same-hazard reports within 5 km / 10 min).
--     Single timestamp per row avoids a separate clusters table; the
--     "did we already page?" check is `exists where cluster_paged_at is not null`.
--   - promoted_message_id: link to the outbound `messages` row when an
--     operator promotes the report to a broadcast.

alter table public.telegram_storm_reports
  add column if not exists status text not null default 'new'
    check (status in ('new', 'verified', 'dismissed', 'promoted')),
  add column if not exists place_name text,
  add column if not exists cluster_paged_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references auth.users(id) on delete set null,
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid references auth.users(id) on delete set null,
  add column if not exists promoted_at timestamptz,
  add column if not exists promoted_by uuid references auth.users(id) on delete set null,
  add column if not exists promoted_message_id uuid references public.messages(id) on delete set null;

create index if not exists telegram_storm_reports_status_idx
  on public.telegram_storm_reports (status, reported_at desc);

-- Cluster detection. Called by the telegram-webhook after each insert.
-- Returns a single row with cluster summary IFF this report just tipped a
-- previously-unpaged group over the 2-report threshold (same hazard, within
-- 5 km, within ±10 min). Returns 0 rows otherwise (single report, or the
-- cluster was already paged).
--
-- When firing, also stamps cluster_paged_at on every nearby report so a
-- 3rd / 4th late-arriving spotter doesn't re-page the operator.
drop function if exists public.detect_storm_report_cluster(uuid);
create function public.detect_storm_report_cluster(p_report_id uuid)
returns table(
  cluster_size int,
  hazard text,
  centroid_lat double precision,
  centroid_lon double precision,
  earliest_at timestamptz,
  report_ids uuid[]
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hazard text;
  v_point geography;
  v_reported_at timestamptz;
  v_count int;
  v_any_paged boolean;
begin
  select r.hazard, r.point, r.reported_at
    into v_hazard, v_point, v_reported_at
  from public.telegram_storm_reports r
  where r.id = p_report_id;
  if v_hazard is null then return; end if;

  select count(*), bool_or(cluster_paged_at is not null)
    into v_count, v_any_paged
  from public.telegram_storm_reports
  where hazard = v_hazard
    and reported_at between v_reported_at - interval '10 minutes'
                        and v_reported_at + interval '10 minutes'
    and st_dwithin(point, v_point, 5000);

  if v_count < 2 then
    return;
  end if;

  if v_any_paged then
    -- Cluster already announced; just attach this report so it's counted
    -- against future window checks for the same group.
    update public.telegram_storm_reports
      set cluster_paged_at = now()
      where id = p_report_id and cluster_paged_at is null;
    return;
  end if;

  -- Fresh cluster. Stamp every nearby unpaged report, then emit the summary.
  update public.telegram_storm_reports
    set cluster_paged_at = now()
  where hazard = v_hazard
    and reported_at between v_reported_at - interval '10 minutes'
                        and v_reported_at + interval '10 minutes'
    and st_dwithin(point, v_point, 5000)
    and cluster_paged_at is null;

  return query
  select
    count(*)::int,
    v_hazard,
    avg(r.lat),
    avg(r.lon),
    min(r.reported_at),
    array_agg(r.id order by r.reported_at)
  from public.telegram_storm_reports r
  where r.hazard = v_hazard
    and r.reported_at between v_reported_at - interval '10 minutes'
                        and v_reported_at + interval '10 minutes'
    and st_dwithin(r.point, v_point, 5000);
end$$;

revoke all on function public.detect_storm_report_cluster(uuid) from public, anon;
grant execute on function public.detect_storm_report_cluster(uuid) to service_role;

-- Refresh the GeoJSON RPC so the radar map surfaces status + place_name
-- and can dim dismissed pins client-side.
create or replace function public.telegram_storm_reports_geojson(p_hours integer default 24)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with midsouth as (
    select st_setsrid(st_makeenvelope(-93.5, 32.8, -82.0, 37.5, 4326), 4326)::geography as g
  ),
  recent as (
    select r.id, r.hazard, r.description, r.photo_url, r.lat, r.lon,
           r.reported_at, r.status, r.place_name,
           s.display_name, s.telegram_username
    from public.telegram_storm_reports r
    join public.subscribers s on s.id = r.subscriber_id
    cross join midsouth m
    where r.reported_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
      and r.status <> 'dismissed'
      and st_intersects(r.point, m.g)
    order by r.reported_at desc
    limit 500
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'id', r.id,
          'geometry', jsonb_build_object(
            'type', 'Point',
            'coordinates', jsonb_build_array(r.lon, r.lat)
          ),
          'properties', jsonb_build_object(
            'id', r.id,
            'hazard', r.hazard,
            'description', r.description,
            'photo_url', r.photo_url,
            'reported_at', r.reported_at,
            'status', r.status,
            'place_name', r.place_name,
            'reporter', coalesce(r.display_name, r.telegram_username, 'subscriber')
          )
        )
        order by r.reported_at desc
      ),
      '[]'::jsonb
    )
  )
  from recent r;
$$;
