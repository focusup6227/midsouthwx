-- One-shot context gather for the /forecast AI-draft button. Pulls the
-- snapshot the model needs (SPC outlook labels, latest AFD, active alerts
-- intersecting the area, recent LSRs intersecting the area) in a single
-- round-trip so the server action doesn't have to compose 4 separate
-- queries + spatial intersections in TypeScript.
--
-- Returned shape:
--   {
--     "area_centroid": { "type": "Point", "coordinates": [lng, lat] },
--     "spc":    [ { day_number, highest_label, issued_at, valid_from, valid_until }, ... ],
--     "afd":    { wfo, issued_at, synopsis, short_term, ai_summary } | null,
--     "alerts": [ { event, headline, ai_summary, severity, effective, expires_at }, ... ],
--     "lsrs":   [ { event, hazard, magnitude, location, occurred_at }, ... ]
--   }
--
-- spc[].highest_label is the day's region-wide top risk (e.g. ENH, MDT). We
-- intentionally do NOT compute per-feature intersection here for v1 — that
-- would require expanding the geojson FeatureCollection and intersecting
-- each polygon. Today's highest_label is a reasonable bias hint for the
-- model; it can phrase outlooks as "the broader region is under MDT, your
-- area falls inside the western edge" etc. Improve later if needed.
--
-- security invoker → RLS on the underlying tables applies. Operators have
-- full select; everyone else gets denied automatically.

create or replace function public.forecast_context(
  p_area jsonb,
  p_lookback_hours int default 24
) returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_g    geometry;
  v_geog geography;
  v_centroid geometry;
  v_lookback int := greatest(coalesce(p_lookback_hours, 24), 1);
begin
  if not public.is_operator() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_area is null or p_area->>'type' is null then
    raise exception 'area is required';
  end if;

  v_g := st_setsrid(st_geomfromgeojson(p_area::text), 4326);
  if v_g is null then
    raise exception 'invalid GeoJSON area';
  end if;
  if st_geometrytype(v_g) = 'ST_Polygon' then
    v_geog := st_multi(v_g)::geography;
  elsif st_geometrytype(v_g) = 'ST_MultiPolygon' then
    v_geog := v_g::geography;
  else
    raise exception 'area must be Polygon or MultiPolygon, got %', st_geometrytype(v_g);
  end if;

  v_centroid := st_centroid(v_g);

  return jsonb_build_object(
    'area_centroid', jsonb_build_object(
      'type', 'Point',
      'coordinates', jsonb_build_array(st_x(v_centroid), st_y(v_centroid))
    ),
    'spc', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day_number', s.day_number,
        'highest_label', s.highest_label,
        'issued_at', s.issued_at,
        'valid_from', s.valid_from,
        'valid_until', s.valid_until
      ) order by s.day_number)
      from public.spc_outlooks s
      where s.day_number in (1, 2, 3)
    ), '[]'::jsonb),
    'afd', (
      select to_jsonb(t) from (
        select wfo, issued_at, synopsis, short_term, ai_summary
        from public.nws_afd
        order by issued_at desc
        limit 1
      ) t
    ),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event', a.event,
        'headline', a.headline,
        'ai_summary', a.ai_summary,
        'severity', a.severity,
        'effective', a.effective,
        'expires_at', a.expires_at
      ) order by a.effective desc nulls last)
      from public.nws_alerts a
      where a.polygon is not null
        and a.status in ('new', 'dispatched')
        and st_intersects(a.polygon, v_geog)
      limit 50
    ), '[]'::jsonb),
    'lsrs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event', r.event,
        'hazard', r.hazard,
        'magnitude', r.magnitude,
        'location', r.location,
        'occurred_at', r.occurred_at
      ) order by r.occurred_at desc)
      from public.nws_storm_reports r
      where r.occurred_at >= now() - make_interval(hours => v_lookback)
        and st_intersects(r.point, v_geog)
      limit 50
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.forecast_context(jsonb, int) from public, anon;
grant execute on function public.forecast_context(jsonb, int) to authenticated, service_role;
