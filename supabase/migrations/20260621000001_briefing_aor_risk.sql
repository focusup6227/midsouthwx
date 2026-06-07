-- Clip the briefing's SPC "highest risk" headline to the Mid-South AOR.
--
-- `spc_outlooks.highest_label` is the worst categorical band anywhere in the
-- *national* SPC outlook, so the /briefing day tiles (and the shareable
-- outlook card) would scream "ENH"/"MDT" even on days when the Mid-South only
-- sits under a SLGT — the high risk was off in the Plains. Operators read that
-- as "favoring" a scarier day than we actually have over our coverage area.
--
-- Fix: compute the highest band whose polygon actually intersects the Mid-South
-- box and surface that to daily_briefing_snapshot(). The box matches the AOR
-- framed by the outlook card (app/cards/outlook/route.ts: AOR_BBOX) so the
-- briefing tiles and the downloadable graphic agree.

-- Highest SPC label (TSTM..HIGH) among the stored day's features that intersect
-- the Mid-South AOR. Returns NULL when no band reaches our area.
create or replace function public.spc_highest_label_in_aor(p_day_number integer)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select f->'properties'->>'LABEL'
  from public.spc_outlooks o
  cross join lateral jsonb_array_elements(coalesce(o.geojson->'features', '[]'::jsonb)) as f
  where o.day_number = p_day_number
    and coalesce(f->'properties'->>'LABEL', '') <> ''
    and st_intersects(
          st_setsrid(st_geomfromgeojson(f->'geometry'), 4326),
          st_makeenvelope(-94.3, 32.2, -84.6, 38.6, 4326)
        )
  order by public.spc_label_rank(f->'properties'->>'LABEL') desc
  limit 1;
$$;

revoke all on function public.spc_highest_label_in_aor(integer) from public, anon;
grant execute on function public.spc_highest_label_in_aor(integer) to authenticated, service_role;

-- Re-create the briefing aggregator so the day-1/2/3 `highest_label` reflects
-- the Mid-South AOR. Everything else is unchanged from
-- 20260618000001_warning_report_overlap.sql.
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
        'highest_label', public.spc_highest_label_in_aor(day_number),
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
