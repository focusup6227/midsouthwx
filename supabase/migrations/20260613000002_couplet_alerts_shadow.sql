-- F9 (extension): couplet pre-alerts, shadow mode.
--
-- Shadow mode = the dispatcher evaluates every candidate track end-to-end
-- (thresholds, environmental gating via active SPC watches, motion
-- projection, audience match) and persists the decision to couplet_alerts,
-- but never inserts into messages or outbound_queue. Subscribers receive
-- nothing. The table is for offline analysis to tune thresholds against
-- real radar before flipping to live mode (controlled by the
-- COUPLET_DISPATCHER_LIVE env var on the edge function).
--
-- The four-tier environmental scheme: PDS Tornado Watch lets us fire at
-- lower shear (60 kt); plain Tornado Watch at 70 kt; Severe T-Storm Watch
-- only at 80 kt and only for operator review (would be auto in live mode
-- with tier=PDS_TOR or TOR); outside any active watch we never fire to
-- subscribers but still log for analysis.

create type public.couplet_alert_status as enum (
  -- Shadow-mode decision outcomes:
  'shadow',                  -- would have fired (env+shear+audience all pass)
  'shadow_no_env',           -- shear/persistence pass but no qualifying watch
  'shadow_below_tier',       -- watch present but shear under tier threshold
  'shadow_no_audience',      -- would fire but no subscribers in projected swath
  'shadow_suppressed_nws',   -- NWS Tornado Warning already covers the swath
  -- Live-mode states (reserved; not used in shadow):
  'pending_approval',
  'dispatched',
  'cancelled',
  'expired'
);

create table public.couplet_alerts (
  id uuid primary key default gen_random_uuid(),
  track_id text not null,
  fired_at timestamptz not null default now(),

  -- Trigger evidence (snapshot of the track at the moment we evaluated it)
  shear_kt real not null,
  persistence_volumes int not null,
  latest_lat double precision not null,
  latest_lon double precision not null,
  latest_point geography(Point, 4326),
  latest_volume_time timestamptz not null,

  -- Environmental context
  environment_tier text,                -- 'PDS_TOR' | 'TOR' | 'SVR' | null
  watch_alert_id uuid references public.nws_alerts(id) on delete set null,
  watch_event text,
  tier_threshold_kt real,               -- the threshold this track was held to

  -- Motion + projection
  motion_bearing_deg real,
  motion_speed_kmh real,
  projection_minutes int,
  projected_swath geography(Polygon, 4326),
  projected_width_km real,

  -- Audience snapshot (what *would* have received this alert in live mode)
  audience_count int not null default 0,
  audience_subscriber_ids uuid[],

  -- Status + linkage
  status public.couplet_alert_status not null default 'shadow',
  notes text,
  message_id uuid references public.messages(id) on delete set null,
  suppressing_nws_alert_id uuid references public.nws_alerts(id) on delete set null,

  created_at timestamptz not null default now()
);

create index couplet_alerts_track_fired_idx
  on public.couplet_alerts (track_id, fired_at desc);
create index couplet_alerts_fired_idx
  on public.couplet_alerts (fired_at desc);
create index couplet_alerts_status_idx
  on public.couplet_alerts (status, fired_at desc);
create index couplet_alerts_swath_gix
  on public.couplet_alerts using gist (projected_swath);

alter table public.couplet_alerts enable row level security;

create policy "op couplet_alerts_select"
  on public.couplet_alerts for select
  using (public.is_operator());

-- service_role bypasses RLS for inserts from the dispatcher; no INSERT
-- policy granted to anon/authenticated by design.

-- ───────────────────────────────────────────────────────────────────────
-- couplet_environment(p_lat, p_lon)
-- Returns the strongest active SPC watch the point falls inside, ranked
-- PDS_TOR > TOR > SVR. Returns null tier when point is outside all
-- qualifying active watches. Uses the polygon path only; UGC-only
-- watches without a polygon are skipped (rare in modern CAP feeds).
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.couplet_environment(
  p_lat double precision,
  p_lon double precision
)
returns table (
  tier text,
  watch_alert_id uuid,
  watch_event text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with p as (
    select st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography as g
  ),
  candidates as (
    select
      na.id,
      na.event,
      case
        when na.event ilike '%Tornado Watch%' and (
          coalesce(na.raw#>>'{properties,parameters,tornadoDamageThreat,0}', '') ilike 'CATASTROPHIC'
          or coalesce(na.headline, '') ilike '%Particularly Dangerous Situation%'
          or coalesce(na.description, '') ilike '%Particularly Dangerous Situation%'
        ) then 'PDS_TOR'
        when na.event = 'Tornado Watch' then 'TOR'
        when na.event = 'Severe Thunderstorm Watch' then 'SVR'
        else null
      end as tier_label
    from public.nws_alerts na, p
    where na.event in ('Tornado Watch', 'Severe Thunderstorm Watch')
      and na.status in ('new', 'dispatched')
      and (na.expires_at is null or na.expires_at > now())
      and na.polygon is not null
      and st_intersects(p.g, na.polygon)
  )
  select tier_label, id, event
  from candidates
  where tier_label is not null
  order by case tier_label when 'PDS_TOR' then 0 when 'TOR' then 1 when 'SVR' then 2 else 9 end
  limit 1;
$$;

revoke all on function public.couplet_environment(double precision, double precision) from public, anon, authenticated;
grant execute on function public.couplet_environment(double precision, double precision) to service_role;

-- ───────────────────────────────────────────────────────────────────────
-- couplet_track_motion(p_track_id, p_window_minutes)
-- Compute the track's recent motion vector from its earliest + latest
-- detections inside the window. Bearing in degrees clockwise from north,
-- speed in km/h. Returns null bearing/speed when fewer than 2 detections.
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.couplet_track_motion(
  p_track_id text,
  p_window_minutes int default 20
)
returns table (
  detections int,
  max_shear_kt real,
  latest_lat double precision,
  latest_lon double precision,
  latest_volume_time timestamptz,
  earliest_volume_time timestamptz,
  motion_bearing_deg real,
  motion_speed_kmh real
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_cutoff timestamptz := now() - make_interval(mins => p_window_minutes);
  v_latest_lat double precision;
  v_latest_lon double precision;
  v_latest_time timestamptz;
  v_earliest_lat double precision;
  v_earliest_lon double precision;
  v_earliest_time timestamptz;
  v_count int;
  v_max_shear real;
  v_bearing real;
  v_speed_kmh real;
begin
  select count(*)::int, max(shear_kt)
  into v_count, v_max_shear
  from public.radar_couplets
  where track_id = p_track_id
    and volume_time_utc >= v_cutoff;

  if v_count = 0 then
    return;
  end if;

  select lat, lon, volume_time_utc
  into v_latest_lat, v_latest_lon, v_latest_time
  from public.radar_couplets
  where track_id = p_track_id
    and volume_time_utc >= v_cutoff
  order by volume_time_utc desc
  limit 1;

  select lat, lon, volume_time_utc
  into v_earliest_lat, v_earliest_lon, v_earliest_time
  from public.radar_couplets
  where track_id = p_track_id
    and volume_time_utc >= v_cutoff
  order by volume_time_utc asc
  limit 1;

  if v_count >= 2 and v_latest_time > v_earliest_time then
    -- st_azimuth raises on identical points (a stationary detection); skip
    -- bearing entirely if start and end are within ~10 m of each other.
    declare
      v_distance_m double precision := st_distance(
        st_setsrid(st_makepoint(v_earliest_lon, v_earliest_lat), 4326)::geography,
        st_setsrid(st_makepoint(v_latest_lon, v_latest_lat), 4326)::geography
      );
    begin
      if v_distance_m > 10 then
        v_bearing := degrees(st_azimuth(
          st_setsrid(st_makepoint(v_earliest_lon, v_earliest_lat), 4326),
          st_setsrid(st_makepoint(v_latest_lon, v_latest_lat), 4326)
        ))::real;
        v_speed_kmh := (
          v_distance_m / 1000.0
          / (extract(epoch from (v_latest_time - v_earliest_time)) / 3600.0)
        )::real;
      end if;
    end;
  end if;

  return query select
    v_count, v_max_shear,
    v_latest_lat, v_latest_lon, v_latest_time, v_earliest_time,
    v_bearing, v_speed_kmh;
end$$;

revoke all on function public.couplet_track_motion(text, int) from public, anon, authenticated;
grant execute on function public.couplet_track_motion(text, int) to service_role;

-- ───────────────────────────────────────────────────────────────────────
-- couplet_projected_swath(...)
-- Build a forward-projected rectangle (centered on the line from current
-- position to projected position) representing the rotation's anticipated
-- impact swath over the next p_minutes minutes. Width is the perpendicular
-- buffer applied to that line. Returns null when motion is unknown.
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.couplet_projected_swath(
  p_lat double precision,
  p_lon double precision,
  p_bearing_deg real,
  p_speed_kmh real,
  p_minutes int,
  p_width_km real
)
returns geography
language plpgsql
immutable
security definer
set search_path = public, extensions
as $$
declare
  v_distance_m double precision;
  v_origin geography := st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography;
  v_endpoint geography;
  v_line geography;
begin
  if p_bearing_deg is null or p_speed_kmh is null or p_speed_kmh <= 0 then
    return null;
  end if;
  v_distance_m := p_speed_kmh * 1000.0 * (p_minutes::double precision / 60.0);
  -- st_project handles geodesic projection on a sphere; bearing is radians clockwise from north.
  v_endpoint := st_project(v_origin, v_distance_m, radians(p_bearing_deg::double precision));
  v_line := st_makeline(v_origin::geometry, v_endpoint::geometry)::geography;
  return st_buffer(v_line, p_width_km * 1000.0 / 2.0);
end$$;

revoke all on function public.couplet_projected_swath(double precision, double precision, real, real, int, real) from public, anon, authenticated;
grant execute on function public.couplet_projected_swath(double precision, double precision, real, real, int, real) to service_role;

-- ───────────────────────────────────────────────────────────────────────
-- couplet_shadow_audience(...)
-- Returns subscriber IDs whose location point falls inside the projected
-- swath built from the supplied motion parameters. Polygon-only match —
-- subscribers without a location point are excluded (same gap as
-- nws_alert_audience's polygon branch; tracked separately).
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.couplet_shadow_audience(
  p_lat double precision,
  p_lon double precision,
  p_bearing_deg real,
  p_speed_kmh real,
  p_minutes int,
  p_width_km real
)
returns table (subscriber_id uuid)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with swath as (
    select public.couplet_projected_swath(
      p_lat, p_lon, p_bearing_deg, p_speed_kmh, p_minutes, p_width_km
    ) as g
  )
  select distinct s.id
  from public.subscribers s, swath
  where s.status = 'active'
    and s.location is not null
    and swath.g is not null
    and st_intersects(s.location, swath.g);
$$;

revoke all on function public.couplet_shadow_audience(double precision, double precision, real, real, int, real) from public, anon, authenticated;
grant execute on function public.couplet_shadow_audience(double precision, double precision, real, real, int, real) to service_role;

-- ───────────────────────────────────────────────────────────────────────
-- couplet_nws_suppressor(...)
-- Returns the strongest active NWS Tornado Warning whose polygon
-- intersects the projected swath, if any. Used to mark couplet_alerts
-- as 'shadow_suppressed_nws' so the analysis can separate "we were ahead
-- of NWS" from "NWS already had this covered."
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.couplet_nws_suppressor(
  p_lat double precision,
  p_lon double precision,
  p_bearing_deg real,
  p_speed_kmh real,
  p_minutes int,
  p_width_km real
)
returns table (nws_alert_id uuid, event text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with swath as (
    select public.couplet_projected_swath(
      p_lat, p_lon, p_bearing_deg, p_speed_kmh, p_minutes, p_width_km
    ) as g
  )
  select na.id, na.event
  from public.nws_alerts na, swath
  where na.event = 'Tornado Warning'
    and na.status in ('new', 'dispatched')
    and (na.expires_at is null or na.expires_at > now())
    and na.polygon is not null
    and swath.g is not null
    and st_intersects(na.polygon, swath.g)
  order by na.sent_at desc nulls last
  limit 1;
$$;

revoke all on function public.couplet_nws_suppressor(double precision, double precision, real, real, int, real) from public, anon, authenticated;
grant execute on function public.couplet_nws_suppressor(double precision, double precision, real, real, int, real) to service_role;

-- ───────────────────────────────────────────────────────────────────────
-- claim_couplet_candidate_tracks()
-- Returns track_ids in the last p_window_minutes that have:
--   - at least p_min_volumes distinct volume scans, AND
--   - max shear_kt >= p_min_shear_kt, AND
--   - no couplet_alerts row in the last p_dedup_minutes (any status)
-- Ordered by max_shear desc so the strongest candidates evaluate first.
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.claim_couplet_candidate_tracks(
  p_window_minutes int default 20,
  p_min_volumes int default 3,
  p_min_shear_kt real default 60.0,
  p_dedup_minutes int default 30
)
returns table (track_id text, max_shear_kt real, volume_count int)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with recent as (
    select rc.track_id, count(distinct rc.volume_time_utc)::int as vc, max(rc.shear_kt) as ms
    from public.radar_couplets rc
    where rc.volume_time_utc >= now() - make_interval(mins => p_window_minutes)
    group by rc.track_id
    having count(distinct rc.volume_time_utc) >= p_min_volumes
       and max(rc.shear_kt) >= p_min_shear_kt
  ),
  recently_seen as (
    select distinct ca.track_id
    from public.couplet_alerts ca
    where ca.fired_at >= now() - make_interval(mins => p_dedup_minutes)
  )
  select r.track_id, r.ms, r.vc
  from recent r
  where r.track_id not in (select track_id from recently_seen)
  order by r.ms desc
  limit 50;
$$;

revoke all on function public.claim_couplet_candidate_tracks(int, int, real, int) from public, anon, authenticated;
grant execute on function public.claim_couplet_candidate_tracks(int, int, real, int) to service_role;

-- ───────────────────────────────────────────────────────────────────────
-- Retention: keep shadow-mode logs 30 days. Long enough to back-test
-- threshold tuning against a meaningful sample of severe-weather days.
-- Live-mode rows (dispatched, pending_approval, etc.) keep the same
-- window — couplet alerts are situational signals, not legal records.
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.prune_couplet_alerts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  delete from public.couplet_alerts
  where fired_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end$$;

revoke all on function public.prune_couplet_alerts() from public, anon, authenticated;
grant execute on function public.prune_couplet_alerts() to service_role;
