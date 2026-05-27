-- Two related fixes for the /radar map's NWS overlay:
--
-- 1) nws_upsert_geojson_feature compared st_geometrytype(v_g) against
--    'STPolygon' / 'STMultiPolygon', but PostGIS returns 'ST_Polygon' /
--    'ST_MultiPolygon' (with the underscore). The check never matched, so
--    every alert was stored with polygon = null and the radar RPC has been
--    leaning on its raw->'geometry' fallback path for everything.
--
-- 2) nws_alerts_radar_geojson re-introduced a mid-south envelope filter in
--    20260601000005_radar_geojson_history.sql, which silently dropped any
--    alert outside the TN/MS/AR box. The operator needs nationwide
--    situational awareness (Colorado warnings, multi-state watches, etc.)
--    so we widen the function back to CONUS-wide. The 3-hour lookback for
--    recently-expired alerts (kept for timeline scrub) stays as-is.
--
-- After applying:  npm run db:push  (then the radar refreshes within 90 s
-- thanks to the existing SWR + Supabase Realtime invalidation).

create or replace function public.nws_upsert_geojson_feature(p_feature jsonb)
returns void
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_nws_id text := coalesce(
    nullif(trim(p_feature#>>'{properties,id}'), ''),
    nullif(trim(p_feature->>'id'), ''),
    nullif(trim(p_feature->'properties'->>'@id'), '')
  );
  v_event text := coalesce(p_feature#>>'{properties,event}', 'Unknown');
  v_geom jsonb := p_feature->'geometry';
  v_poly geography(MultiPolygon, 4326);
  v_g geometry;
  refs text := p_feature#>>'{properties,references}';
  v_status public.nws_status := 'new';
begin
  if coalesce(p_feature#>>'{properties,messageType}', '') = 'Cancel' then
    v_status := 'cancelled';
  end if;

  if v_nws_id is null or length(trim(v_nws_id)) = 0 then
    return;
  end if;

  if v_geom is not null and v_geom != 'null'::jsonb and v_geom->>'type' is not null then
    v_g := st_setsrid(st_geomfromgeojson(v_geom::text), 4326);
    if v_g is null then
      v_poly := null;
    elsif st_geometrytype(v_g) = 'ST_Polygon' then
      v_poly := st_multi(v_g)::geography;
    elsif st_geometrytype(v_g) = 'ST_MultiPolygon' then
      v_poly := v_g::geography;
    else
      v_poly := null;
    end if;
  else
    v_poly := null;
  end if;

  insert into public.nws_alerts (
    nws_id,
    event,
    severity,
    certainty,
    urgency,
    headline,
    description,
    instruction,
    area_desc,
    ugc_codes,
    same_codes,
    polygon,
    sent_at,
    effective,
    expires_at,
    status,
    references_ids,
    raw
  )
  values (
    v_nws_id,
    v_event,
    nullif(p_feature#>>'{properties,severity}', ''),
    nullif(p_feature#>>'{properties,certainty}', ''),
    nullif(p_feature#>>'{properties,urgency}', ''),
    nullif(p_feature#>>'{properties,headline}', ''),
    nullif(p_feature#>>'{properties,description}', ''),
    nullif(p_feature#>>'{properties,instruction}', ''),
    nullif(p_feature#>>'{properties,areaDesc}', ''),
    case
      when p_feature#>'{properties,affectedZones}' is not null
      then array(select jsonb_array_elements_text(p_feature#>'{properties,affectedZones}'))
      else null
    end,
    case
      when p_feature#>'{properties,geocode,SAME}' is not null
      then array(select jsonb_array_elements_text(p_feature#>'{properties,geocode,SAME}'))
      else null
    end,
    v_poly,
    (nullif(p_feature#>>'{properties,sent}', ''))::timestamptz,
    (nullif(p_feature#>>'{properties,effective}', ''))::timestamptz,
    (nullif(p_feature#>>'{properties,ends}', ''))::timestamptz,
    v_status,
    case
      when refs is not null and length(trim(refs)) > 0
      then regexp_split_to_array(trim(refs), '\s+')
      else null
    end,
    p_feature
  )
  on conflict (nws_id) do update set
    event = excluded.event,
    severity = excluded.severity,
    certainty = excluded.certainty,
    urgency = excluded.urgency,
    headline = excluded.headline,
    description = excluded.description,
    instruction = excluded.instruction,
    area_desc = excluded.area_desc,
    ugc_codes = excluded.ugc_codes,
    same_codes = excluded.same_codes,
    polygon = excluded.polygon,
    sent_at = excluded.sent_at,
    effective = excluded.effective,
    expires_at = excluded.expires_at,
    references_ids = excluded.references_ids,
    raw = excluded.raw,
    ingested_at = now(),
    status = case
      when nws_alerts.status in ('dispatched', 'skipped', 'superseded')
      then nws_alerts.status
      when excluded.raw#>>'{properties,messageType}' = 'Cancel'
      then 'cancelled'::public.nws_status
      else 'new'::public.nws_status
    end;
end;
$$;

-- Backfill: re-derive `polygon` for every row whose raw feature has a usable
-- Polygon/MultiPolygon geometry. Cheap enough at our row count to run inline.
update public.nws_alerts na
set polygon = case
  when st_geometrytype(g) = 'ST_Polygon' then st_multi(g)::geography
  when st_geometrytype(g) = 'ST_MultiPolygon' then g::geography
  else null
end
from (
  select
    id,
    st_setsrid(st_geomfromgeojson((raw->'geometry')::text), 4326) as g
  from public.nws_alerts
  where polygon is null
    and raw->'geometry' is not null
    and raw->'geometry' != 'null'::jsonb
    and (raw#>>'{geometry,type}') in ('Polygon', 'MultiPolygon')
) src
where na.id = src.id
  and src.g is not null;

create or replace function public.nws_alerts_radar_geojson()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with active as (
    select
      na.id,
      na.nws_id,
      na.event,
      na.severity,
      na.headline,
      na.area_desc,
      na.expires_at,
      na.effective,
      na.status,
      na.ai_summary,
      coalesce(
        case when na.polygon is not null then st_asgeojson(na.polygon::geometry)::jsonb end,
        case
          when na.raw->'geometry' is not null and na.raw->'geometry' != 'null'::jsonb
          then na.raw->'geometry'
        end
      ) as geometry
    from public.nws_alerts na
    where (
      na.status in ('new', 'dispatched')
      or (na.status = 'expired' and na.expires_at >= now() - interval '3 hours')
    )
      and (na.expires_at is null or na.expires_at >= now() - interval '3 hours')
      and (
        na.polygon is not null
        or (
          na.raw->'geometry' is not null
          and na.raw->'geometry' != 'null'::jsonb
          and (na.raw#>>'{geometry,type}') in ('Polygon', 'MultiPolygon')
        )
      )
    order by na.ingested_at desc
    limit 1000
  ),
  with_geom as (
    select *
    from active
    where geometry is not null
      and (geometry->>'type') in ('Polygon', 'MultiPolygon')
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'id', w.id::text,
          'geometry', w.geometry,
          'properties', jsonb_build_object(
            'id', w.id,
            'nws_id', w.nws_id,
            'event', w.event,
            'severity', w.severity,
            'headline', w.headline,
            'area_desc', w.area_desc,
            'expires_at', w.expires_at,
            'effective', w.effective,
            'status', w.status,
            'ai_summary', w.ai_summary
          )
        )
        order by w.event
      ),
      '[]'::jsonb
    )
  )
  from with_geom w;
$$;

revoke all on function public.nws_alerts_radar_geojson() from public, anon;
grant execute on function public.nws_alerts_radar_geojson() to authenticated, service_role;

revoke all on function public.nws_upsert_geojson_feature(jsonb) from public, anon, authenticated;
grant execute on function public.nws_upsert_geojson_feature(jsonb) to service_role;
