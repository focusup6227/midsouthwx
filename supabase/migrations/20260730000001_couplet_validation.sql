-- Couplet detection validation ("Phase 4" from the detector's design notes).
--
-- Joins radar_couplets tracks against NWS Tornado Warnings so the operator
-- can see, per site, how often a detected rotation was followed/covered by a
-- warning — the data needed to tune min_shear_kt and the TDS CC threshold,
-- and the prerequisite for ever trusting auto-fire.
--
-- "Verified" = any Tornado Warning whose polygon comes within 10 km of any
-- detection point of the track, with a time window overlapping
-- [first_seen − 10 min, last_seen + 30 min] (a warning may precede radar
-- detection or follow it as the couplet matures).

create or replace function public.couplet_validation_tracks(p_days integer default 30)
returns table (
  track_id text,
  site text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  volume_count integer,
  max_shear_kt real,
  had_tds boolean,
  verified boolean,
  warning_event text
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with tracks as (
    select
      c.track_id,
      c.site,
      min(c.volume_time_utc) as first_seen_at,
      max(c.volume_time_utc) as last_seen_at,
      count(*)::int as volume_count,
      max(c.shear_kt) as max_shear_kt,
      bool_or(coalesce(c.tds, false)) as had_tds,
      st_collect(c.point::geometry) as pts
    from public.radar_couplets c
    where c.scanned_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
    group by c.track_id, c.site
  )
  select
    t.track_id,
    t.site,
    t.first_seen_at,
    t.last_seen_at,
    t.volume_count,
    t.max_shear_kt,
    t.had_tds,
    w.id is not null as verified,
    w.event as warning_event
  from tracks t
  left join lateral (
    select a.id, a.event
    from public.nws_alerts a
    where a.event ilike '%tornado warning%'
      and a.polygon is not null
      and coalesce(a.effective, a.ingested_at) <= t.last_seen_at + interval '30 minutes'
      and coalesce(a.expires_at, a.ingested_at + interval '1 hour') >= t.first_seen_at - interval '10 minutes'
      and st_dwithin(a.polygon, t.pts::geography, 10000)
    limit 1
  ) w on true
  order by t.last_seen_at desc;
$$;

revoke all on function public.couplet_validation_tracks(integer) from public, anon;
grant execute on function public.couplet_validation_tracks(integer)
  to authenticated, service_role;
