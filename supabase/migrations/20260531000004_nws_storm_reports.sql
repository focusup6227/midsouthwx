-- F4 (NWS Storm Reports overlay): persistent log of NWS Local Storm Reports
-- inside the mid-south AOR. Source is the IEM (Iowa Environmental Mesonet)
-- LSR GeoJSON feed — it normalizes the WFO-issued LSR text products into
-- structured features with lat/lon, event type, magnitude, and remarks.
--
-- Pinned on /radar so the operator can answer "did the warning we sent
-- actually line up with what got reported on the ground?" Polled every 5
-- min by the lsr-poll edge function; retained 90 days to mirror nws_alerts.

create table if not exists public.nws_storm_reports (
  -- IEM's stable per-report id: typically "<wfo>-<utc-yyyymmddhhmm>-<seq>".
  id text primary key,
  event text not null,         -- TORNADO, HAIL, TSTM WND GST, FLASH FLOOD, ...
  hazard text,                 -- our normalized kind (tornado|severe|flood|wind|winter|heat|other)
  magnitude text,              -- "EF1", "1.5 IN", "M73", etc. — free-text per LSR
  remark text,                 -- spotter / NWS free-text comment
  location text,               -- "2 NE BARTLETT" or "Memphis", from the LSR
  wfo text,                    -- 3-char issuing WFO (e.g. MEG)
  state text,                  -- 2-char state code
  source text,                 -- "Trained Spotter", "Public", "Emergency Mngr", ...
  occurred_at timestamptz not null,
  lat double precision not null,
  lon double precision not null,
  point geography(Point, 4326),
  raw jsonb not null,
  ingested_at timestamptz not null default now()
);

create index if not exists nws_storm_reports_point_gix
  on public.nws_storm_reports using gist (point);
create index if not exists nws_storm_reports_occurred_idx
  on public.nws_storm_reports (occurred_at desc);
create index if not exists nws_storm_reports_hazard_idx
  on public.nws_storm_reports (hazard, occurred_at desc)
  where hazard is not null;

alter table public.nws_storm_reports enable row level security;

create policy "op nws_storm_reports_select"
  on public.nws_storm_reports for select
  using (public.is_operator());

-- Upsert one IEM LSR GeoJSON Feature. Called by the lsr-poll edge fn.
-- Idempotent on id (re-ingesting the same report is a noop / refresh).
create or replace function public.nws_storm_reports_upsert(p_feature jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text;
  v_event text;
  v_lat double precision;
  v_lon double precision;
  v_occurred timestamptz;
  v_props jsonb := coalesce(p_feature->'properties', '{}'::jsonb);
  v_geom jsonb := p_feature->'geometry';
  v_coords jsonb;
  v_hazard text;
  v_event_uc text;
begin
  -- Prefer the explicit id; fall back to a deterministic composite.
  v_id := nullif(coalesce(
    v_props->>'product_id',
    v_props->>'id',
    p_feature->>'id'
  ), '');
  if v_id is null then
    v_id := concat_ws(
      '-',
      coalesce(v_props->>'wfo', '----'),
      coalesce(v_props->>'utc_valid', v_props->>'valid', ''),
      coalesce(v_props->>'event', 'UNK'),
      coalesce(v_props->>'lat', ''),
      coalesce(v_props->>'lon', '')
    );
  end if;

  v_event := upper(trim(coalesce(v_props->>'event', 'UNKNOWN')));
  v_event_uc := v_event;

  -- Hazard normalization keeps the LSR overlay color-codable with the same
  -- palette as warnings. Order matters — narrower matches first.
  if v_event_uc like '%TORNADO%' or v_event_uc like '%FUNNEL%' then
    v_hazard := 'tornado';
  elsif v_event_uc like '%HAIL%' or v_event_uc like 'TSTM WND%' or v_event_uc like '%THUNDER%' then
    v_hazard := 'severe';
  elsif v_event_uc like '%FLASH FLOOD%' or v_event_uc like '%FLOOD%' then
    v_hazard := 'flood';
  elsif v_event_uc like '%SNOW%' or v_event_uc like '%ICE%' or v_event_uc like '%BLIZZARD%' or v_event_uc like '%FREEZ%' then
    v_hazard := 'winter';
  elsif v_event_uc like '%HEAT%' then
    v_hazard := 'heat';
  elsif v_event_uc like '%WIND%' or v_event_uc like '%GUST%' then
    v_hazard := 'wind';
  else
    v_hazard := 'other';
  end if;

  v_coords := v_geom->'coordinates';
  if v_coords is null or jsonb_typeof(v_coords) <> 'array' then
    return;
  end if;
  v_lon := (v_coords->>0)::double precision;
  v_lat := (v_coords->>1)::double precision;
  if v_lat is null or v_lon is null then return; end if;

  v_occurred := coalesce(
    (v_props->>'utc_valid')::timestamptz,
    (v_props->>'valid')::timestamptz,
    now()
  );

  insert into public.nws_storm_reports (
    id, event, hazard, magnitude, remark, location, wfo, state, source,
    occurred_at, lat, lon, point, raw
  ) values (
    v_id,
    v_event,
    v_hazard,
    nullif(v_props->>'magnitude', ''),
    nullif(v_props->>'remark', ''),
    nullif(v_props->>'city', v_props->>'county'),
    nullif(v_props->>'wfo', ''),
    nullif(v_props->>'state', ''),
    nullif(v_props->>'source', ''),
    v_occurred,
    v_lat,
    v_lon,
    st_setsrid(st_makepoint(v_lon, v_lat), 4326)::geography,
    p_feature
  )
  on conflict (id) do update set
    event       = excluded.event,
    hazard      = excluded.hazard,
    magnitude   = excluded.magnitude,
    remark      = excluded.remark,
    location    = excluded.location,
    wfo         = excluded.wfo,
    state       = excluded.state,
    source      = excluded.source,
    occurred_at = excluded.occurred_at,
    lat         = excluded.lat,
    lon         = excluded.lon,
    point       = excluded.point,
    raw         = excluded.raw;
end;
$$;

revoke all on function public.nws_storm_reports_upsert(jsonb) from public, anon;
grant execute on function public.nws_storm_reports_upsert(jsonb) to service_role;

-- Recent LSRs inside the mid-south envelope, as a GeoJSON FeatureCollection,
-- for the /api/radar/lsr endpoint. Mirrors the nws_alerts_radar_geojson shape.
create or replace function public.nws_storm_reports_geojson(p_hours integer default 6)
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
    select r.*
    from public.nws_storm_reports r
    cross join midsouth m
    where r.occurred_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 6), 1))
      and st_intersects(r.point, m.g)
    order by r.occurred_at desc
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
            'event', r.event,
            'hazard', r.hazard,
            'magnitude', r.magnitude,
            'remark', r.remark,
            'location', r.location,
            'wfo', r.wfo,
            'state', r.state,
            'source', r.source,
            'occurred_at', r.occurred_at
          )
        )
        order by r.occurred_at desc
      ),
      '[]'::jsonb
    )
  )
  from recent r;
$$;

revoke all on function public.nws_storm_reports_geojson(integer) from public, anon;
grant execute on function public.nws_storm_reports_geojson(integer) to authenticated, service_role;

-- Pin the existing daily prune cron to drop storm reports past 90d too.
-- Replaces (not appends to) the prior `nws-alerts-prune` schedule so the
-- single job handles both tables in one nightly pass.
select cron.unschedule('nws-alerts-prune') where exists (
  select 1 from cron.job where jobname = 'nws-alerts-prune'
);
select cron.schedule(
  'nws-alerts-prune',
  '15 3 * * *',
  $$
  update public.nws_alerts
  set status = 'expired'
  where expires_at is not null
    and expires_at < now()
    and status = 'new';

  delete from public.nws_alerts
  where ingested_at < now() - interval '90 days';

  delete from public.nws_storm_reports
  where ingested_at < now() - interval '90 days';
  $$
);
