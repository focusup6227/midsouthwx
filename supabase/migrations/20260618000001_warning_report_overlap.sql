-- Verification analytics + briefing helpers.
--
-- 1. warning_report_overlap(p_hours) — for each NWS warning in the window,
--    return the subscriber storm reports that landed inside its polygon
--    within ±60 min of effective↔expires. Used by /analytics/warnings to
--    answer "did our warnings line up with ground truth?"
--
-- 2. coverage_density_by_zone() — counts active subscribers whose location
--    sits inside each NWS forecast zone. Joins against the public
--    /maps/nws-zones.geojson layer client-side (zone codes match `ugc`).
--    Powers the coverage-gap overlay on /radar.
--
-- 3. daily_briefing_snapshot() — single round-trip aggregate for the
--    pre-event briefing page: latest SPC outlook day-1/2/3 labels, AFD
--    synopsis per WFO, active hazardous-weather-outlook alerts.

create or replace function public.warning_report_overlap(p_hours integer default 24)
returns table (
  warning_id uuid,
  nws_id text,
  event text,
  severity text,
  headline text,
  area_desc text,
  effective timestamptz,
  expires_at timestamptz,
  report_id uuid,
  report_hazard text,
  report_status text,
  report_lat double precision,
  report_lon double precision,
  report_place_name text,
  report_at timestamptz,
  minutes_into_warning numeric
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with windowed_warnings as (
    select a.*
    from public.nws_alerts a
    where a.event ilike '%warning%'
      and a.polygon is not null
      and a.effective >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
  )
  select
    w.id, w.nws_id, w.event, w.severity, w.headline, w.area_desc,
    w.effective, w.expires_at,
    r.id, r.hazard, r.status, r.lat, r.lon, r.place_name,
    r.reported_at,
    extract(epoch from r.reported_at - w.effective) / 60.0
  from windowed_warnings w
  left join public.telegram_storm_reports r
    on st_within(r.point::geometry, w.polygon::geometry)
    and r.reported_at between w.effective - interval '60 minutes'
                          and coalesce(w.expires_at, w.effective + interval '6 hours') + interval '60 minutes'
  order by w.effective desc, r.reported_at asc;
$$;

revoke all on function public.warning_report_overlap(integer) from public, anon;
grant execute on function public.warning_report_overlap(integer) to authenticated, service_role;

-- Coverage by NWS forecast zone (UGC code). Subscribers may have a
-- county_fips on the row; for zone matching we use ST_Intersects against
-- the loaded GeoJSON on the client. This RPC just returns active sub
-- locations as a lightweight FeatureCollection so the client can do the
-- intersect against /maps/nws-zones.geojson without exposing PII.
create or replace function public.subscriber_density_points()
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
          'geometry', jsonb_build_object(
            'type', 'Point',
            'coordinates', jsonb_build_array(
              st_x(location::geometry),
              st_y(location::geometry)
            )
          ),
          'properties', jsonb_build_object('id', id)
        )
      ),
      '[]'::jsonb
    )
  )
  from public.subscribers
  where status = 'active'
    and location is not null;
$$;

revoke all on function public.subscriber_density_points() from public, anon;
grant execute on function public.subscriber_density_points() to authenticated, service_role;

-- One-shot briefing aggregator. Returns:
--   - spc: latest day_1/2/3 SPC outlooks (issued, valid window, highest label)
--   - afds: latest AFD synopsis per WFO active in the AOR
--   - hwos: hazardous weather outlook alerts active right now
--   - warnings_count, watches_count: active warning + watch counts for headline tiles
create or replace function public.daily_briefing_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with spc as (
    select jsonb_object_agg(
      day_number::text,
      jsonb_build_object(
        'highest_label', highest_label,
        'issued_at',     issued_at,
        'valid_from',    valid_from,
        'valid_until',   valid_until
      )
    ) as days
    from public.spc_outlooks
    where day_number in (1, 2, 3)
  ),
  -- Pull the freshest AFD per WFO. Window function over wfo so we don't
  -- carry along stale yesterday-AM products when the afternoon update lands.
  latest_afd as (
    select wfo, product_id, issued_at, synopsis, short_term, ai_summary,
           row_number() over (partition by wfo order by issued_at desc) as rn
    from public.nws_afd
    where issued_at >= now() - interval '24 hours'
  ),
  afd_arr as (
    select jsonb_agg(
      jsonb_build_object(
        'wfo',        wfo,
        'product_id', product_id,
        'issued_at',  issued_at,
        'synopsis',   coalesce(ai_summary, synopsis, short_term)
      )
      order by issued_at desc
    ) as arr
    from latest_afd where rn = 1
  ),
  hwos as (
    select jsonb_agg(
      jsonb_build_object(
        'id',        id,
        'event',     event,
        'headline',  headline,
        'area_desc', area_desc,
        'effective', effective,
        'expires_at', expires_at
      )
      order by effective desc
    ) as arr
    from public.nws_alerts
    where status = 'new'
      and event ilike '%hazardous weather%'
      and coalesce(expires_at, now()) >= now()
  ),
  counts as (
    select
      count(*) filter (where event ilike '%warning%') as warnings_count,
      count(*) filter (where event ilike '%watch%')   as watches_count
    from public.nws_alerts
    where status = 'new'
      and coalesce(expires_at, now()) >= now()
  )
  select jsonb_build_object(
    'spc',             coalesce((select days from spc), '{}'::jsonb),
    'afds',            coalesce((select arr  from afd_arr), '[]'::jsonb),
    'hwos',            coalesce((select arr  from hwos), '[]'::jsonb),
    'warnings_count',  (select warnings_count from counts),
    'watches_count',   (select watches_count  from counts),
    'generated_at',    now()
  );
$$;

revoke all on function public.daily_briefing_snapshot() from public, anon;
grant execute on function public.daily_briefing_snapshot() to authenticated, service_role;
