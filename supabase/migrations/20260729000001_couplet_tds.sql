-- Tornado Debris Signature (TDS) support on radar couplets.
--
-- The renderer's /couplets/scan now samples correlation coefficient and
-- reflectivity in a ±2-ray/±3-gate window around each detection. A couplet
-- with CC < 0.80 inside >30 dBZ echo is flagged tds=true — lofted debris is
-- non-meteorological and decorrelates the dual-pol return. Surfaced on the
-- /radar rotation pins as a "TDS" badge.

alter table public.radar_couplets
  add column if not exists tds boolean,
  add column if not exists min_cc real,
  add column if not exists refl_dbz real;

-- Recreate the upsert with defaulted TDS params. Dropping first because
-- adding parameters changes the signature (create or replace can't) and a
-- defaulted 13-arg function would be ambiguous next to the old 10-arg one.
drop function if exists public.radar_couplets_upsert(
  text, double precision, double precision, real, real, real, real,
  text, timestamptz, integer
);

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
  p_scan_age_seconds integer,
  p_tds boolean default null,
  p_min_cc real default null,
  p_refl_dbz real default null
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
    select count(distinct rc.track_id) + 1 into v_seq
    from public.radar_couplets rc
    where rc.site = p_site
      and rc.volume_time_utc::date = p_volume_time_utc::date;
    v_track := p_site || '-' || public.int_to_letters(v_seq);
  end if;

  insert into public.radar_couplets (
    site, lat, lon, point, shear_kt, range_km, azimuth_deg, elevation_deg,
    volume_filename, volume_time_utc, scan_age_seconds, track_id,
    tds, min_cc, refl_dbz
  ) values (
    p_site, p_lat, p_lon, v_geog, p_shear_kt, p_range_km, p_azimuth_deg,
    p_elevation_deg, p_volume_filename, p_volume_time_utc,
    p_scan_age_seconds, v_track,
    p_tds, p_min_cc, p_refl_dbz
  )
  on conflict (site, volume_time_utc, lat, lon) do update
    set shear_kt = excluded.shear_kt,
        range_km = excluded.range_km,
        azimuth_deg = excluded.azimuth_deg,
        elevation_deg = excluded.elevation_deg,
        volume_filename = excluded.volume_filename,
        scan_age_seconds = excluded.scan_age_seconds,
        tds = excluded.tds,
        min_cc = excluded.min_cc,
        refl_dbz = excluded.refl_dbz
  returning radar_couplets.id, radar_couplets.track_id into v_id, v_track;

  return query select v_id, v_track, v_inherited;
end;
$$;

revoke all on function public.radar_couplets_upsert(
  text, double precision, double precision, real, real, real, real,
  text, timestamptz, integer, boolean, real, real
) from public, anon, authenticated;
grant execute on function public.radar_couplets_upsert(
  text, double precision, double precision, real, real, real, real,
  text, timestamptz, integer, boolean, real, real
) to service_role;

-- Pin GeoJSON: expose the TDS fields, plus a track-level "any volume in the
-- window flagged TDS" so the badge doesn't flicker off when one scan's
-- sample misses the debris column.
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
           count(*)::int as volume_count,
           bool_or(coalesce(tds, false)) as track_tds
    from windowed
    group by track_id
  ),
  latest as (
    select distinct on (w.track_id)
      w.*,
      ts.first_seen_at,
      ts.last_seen_at,
      ts.max_shear_kt,
      ts.volume_count,
      ts.track_tds
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
          'volume_count', l.volume_count,
          'tds', l.tds,
          'track_tds', l.track_tds,
          'min_cc', l.min_cc,
          'refl_dbz', l.refl_dbz
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
