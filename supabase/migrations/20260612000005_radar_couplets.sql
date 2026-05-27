-- F9 (NEXRAD velocity-couplet detections / "rotation IDs"):
-- algorithm-detected mesocyclone & TVS candidates derived from gate-to-gate
-- velocity shear in the lowest Level II sweep. Detection is done in the Fly.io
-- renderer (see _renderer/couplet_detect.py, sibling repo midsouthwx-radar-
-- renderer); this table is the persistent store the couplet-poll edge
-- function writes to.
--
-- Why store at all rather than re-render on demand: a real circulation
-- persists across multiple volume scans, and the operator's question is
-- "is this rotation tightening or weakening?" — which requires the trail.
-- We assign a stable track_id by spatial-temporal match across scans
-- (5 km, 12 min window) so each persistent meso shows as one identity
-- (e.g. "KNQA-A") instead of a fresh point every 5 min.
--
-- Retention: 6 hours. These are real-time situational signals; older
-- detections are noise once the event is over. Verification of historical
-- events should use Level II archives, not this table.

create table if not exists public.radar_couplets (
  id uuid primary key default gen_random_uuid(),
  site text not null,                       -- 4-char NEXRAD code, e.g. 'KNQA'
  lat double precision not null,
  lon double precision not null,
  point geography(Point, 4326),
  -- Detection strength + provenance
  shear_kt real not null,                   -- gate-to-gate |Δv|, knots
  range_km real not null,                   -- distance from radar
  azimuth_deg real not null,                -- bearing from radar (0=N)
  elevation_deg real not null,              -- sweep elevation (typically ~0.5)
  volume_filename text not null,            -- e.g. 'KNQA20260524_143215_V06'
  volume_time_utc timestamptz not null,     -- parsed from filename
  scan_age_seconds integer not null,        -- age at fetch time, diagnostic
  -- Cross-scan identity: assigned by the upsert RPC based on a 5 km / 12 min
  -- match to a prior detection from the same site. Stable while the
  -- circulation persists; new identity when the gap exceeds the window.
  track_id text not null,
  scanned_at timestamptz not null default now(),
  -- One row per (site, volume, detection point). Re-running the poll on a
  -- volume we've already ingested is idempotent.
  unique (site, volume_time_utc, lat, lon)
);

create index if not exists radar_couplets_point_gix
  on public.radar_couplets using gist (point);
create index if not exists radar_couplets_site_vol_idx
  on public.radar_couplets (site, volume_time_utc desc);
create index if not exists radar_couplets_track_idx
  on public.radar_couplets (track_id, volume_time_utc desc);
create index if not exists radar_couplets_scanned_idx
  on public.radar_couplets (scanned_at desc);

alter table public.radar_couplets enable row level security;

create policy "op radar_couplets_select"
  on public.radar_couplets for select
  using (public.is_operator());

-- ───────────────────────────────────────────────────────────────────────
-- Helper: 1-indexed Excel-style column letters (1=A, 26=Z, 27=AA, ...).
-- Used to assign human-readable track_id suffixes per site per UTC day.
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.int_to_letters(n integer)
returns text
language plpgsql
immutable
as $$
declare
  result text := '';
  v integer := n;
begin
  if v is null or v < 1 then return 'A'; end if;
  while v > 0 loop
    v := v - 1;
    result := chr(65 + (v % 26)) || result;
    v := v / 26;
  end loop;
  return result;
end;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Upsert one detection. Assigns track_id by spatial-temporal match to
-- prior detections from the same site. Returns the row's id + track_id
-- so the edge function can log diagnostics.
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.radar_couplets_upsert(
  p_site text,
  p_lat double precision,
  p_lon double precision,
  p_shear_kt real,
  p_range_km real,
  p_azimuth_deg real,
  p_elevation_deg real,
  p_volume_filename text,
  p_volume_time_utc timestamptz,
  p_scan_age_seconds integer
)
returns table (id uuid, track_id text, inherited boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_geog geography := st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography;
  v_match_track text;
  v_seq integer;
  v_track text;
  v_id uuid;
  v_inherited boolean := false;
begin
  -- Match to a prior detection from the same site within 5 km and the
  -- last 12 min, excluding this volume. 12 min covers ~2 volume scans so a
  -- skipped scan doesn't fragment the identity; 5 km is wider than typical
  -- meso translation per scan (~1-3 km).
  select rc.track_id into v_match_track
  from public.radar_couplets rc
  where rc.site = p_site
    and rc.volume_time_utc < p_volume_time_utc
    and rc.volume_time_utc >= p_volume_time_utc - interval '12 minutes'
    and st_dwithin(rc.point, v_geog, 5000)
  order by st_distance(rc.point, v_geog), rc.volume_time_utc desc
  limit 1;

  if v_match_track is not null then
    v_track := v_match_track;
    v_inherited := true;
  else
    -- New identity. Per-site, per-UTC-day sequence so IDs reset at 00Z and
    -- a busy day doesn't sprawl into "KNQA-AAAA".
    select count(distinct rc.track_id) + 1 into v_seq
    from public.radar_couplets rc
    where rc.site = p_site
      and rc.volume_time_utc::date = p_volume_time_utc::date;
    v_track := p_site || '-' || public.int_to_letters(v_seq);
  end if;

  insert into public.radar_couplets (
    site, lat, lon, point, shear_kt, range_km, azimuth_deg, elevation_deg,
    volume_filename, volume_time_utc, scan_age_seconds, track_id
  ) values (
    p_site, p_lat, p_lon, v_geog, p_shear_kt, p_range_km, p_azimuth_deg,
    p_elevation_deg, p_volume_filename, p_volume_time_utc,
    p_scan_age_seconds, v_track
  )
  on conflict (site, volume_time_utc, lat, lon) do update
    set shear_kt = excluded.shear_kt,
        range_km = excluded.range_km,
        azimuth_deg = excluded.azimuth_deg,
        elevation_deg = excluded.elevation_deg,
        volume_filename = excluded.volume_filename,
        scan_age_seconds = excluded.scan_age_seconds
  returning radar_couplets.id, radar_couplets.track_id into v_id, v_track;

  return query select v_id, v_track, v_inherited;
end;
$$;

revoke all on function public.radar_couplets_upsert(
  text, double precision, double precision, real, real, real, real,
  text, timestamptz, integer
) from public, anon;
grant execute on function public.radar_couplets_upsert(
  text, double precision, double precision, real, real, real, real,
  text, timestamptz, integer
) to service_role;

-- ───────────────────────────────────────────────────────────────────────
-- GeoJSON: latest detection per track in the recency window, with the
-- count of volumes the track has been seen on + first-seen timestamp so
-- the UI can distinguish a long-lived circulation from a one-shot blip.
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.radar_couplets_geojson(p_minutes integer default 30)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with windowed as (
    select c.*
    from public.radar_couplets c
    where c.volume_time_utc >= now()
      - make_interval(mins => greatest(coalesce(p_minutes, 30), 1))
  ),
  track_stats as (
    select track_id,
           min(volume_time_utc) as first_seen_at,
           max(volume_time_utc) as last_seen_at,
           max(shear_kt) as max_shear_kt,
           count(*)::int as volume_count
    from windowed
    group by track_id
  ),
  latest as (
    select distinct on (w.track_id)
      w.*,
      ts.first_seen_at,
      ts.last_seen_at,
      ts.max_shear_kt,
      ts.volume_count
    from windowed w
    join track_stats ts on ts.track_id = w.track_id
    order by w.track_id, w.volume_time_utc desc
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(
      jsonb_build_object(
        'type', 'Feature',
        'id', l.track_id,
        'geometry', jsonb_build_object(
          'type', 'Point',
          'coordinates', jsonb_build_array(l.lon, l.lat)
        ),
        'properties', jsonb_build_object(
          'track_id', l.track_id,
          'site', l.site,
          'shear_kt', l.shear_kt,
          'max_shear_kt', l.max_shear_kt,
          'range_km', l.range_km,
          'azimuth_deg', l.azimuth_deg,
          'elevation_deg', l.elevation_deg,
          'volume_filename', l.volume_filename,
          'volume_time_utc', l.volume_time_utc,
          'first_seen_at', l.first_seen_at,
          'last_seen_at', l.last_seen_at,
          'volume_count', l.volume_count
        )
      )
      order by l.shear_kt desc
    ), '[]'::jsonb)
  )
  from latest l;
$$;

revoke all on function public.radar_couplets_geojson(integer) from public, anon;
grant execute on function public.radar_couplets_geojson(integer)
  to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────
-- Track history: ordered LineString per track_id over the window, for
-- drawing meso "trails". Returned as a separate FeatureCollection so the
-- pin layer and the trail layer can refresh independently.
-- ───────────────────────────────────────────────────────────────────────
create or replace function public.radar_couplets_tracks_geojson(p_minutes integer default 30)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with windowed as (
    select c.*
    from public.radar_couplets c
    where c.volume_time_utc >= now()
      - make_interval(mins => greatest(coalesce(p_minutes, 30), 1))
  ),
  ordered as (
    select track_id, site,
           array_agg(jsonb_build_array(lon, lat) order by volume_time_utc) as coords,
           count(*)::int as volume_count,
           max(shear_kt) as max_shear_kt
    from windowed
    group by track_id, site
    having count(*) >= 2
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(
      jsonb_build_object(
        'type', 'Feature',
        'id', track_id || '-trail',
        'geometry', jsonb_build_object(
          'type', 'LineString',
          'coordinates', to_jsonb(coords)
        ),
        'properties', jsonb_build_object(
          'track_id', track_id,
          'site', site,
          'volume_count', volume_count,
          'max_shear_kt', max_shear_kt
        )
      )
    ), '[]'::jsonb)
  )
  from ordered;
$$;

revoke all on function public.radar_couplets_tracks_geojson(integer) from public, anon;
grant execute on function public.radar_couplets_tracks_geojson(integer)
  to authenticated, service_role;
