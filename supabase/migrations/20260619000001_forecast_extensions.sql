-- Forecasting extensions:
--   1. score_forecast() upgraded with CSI / POD / FAR alongside the existing
--      count scorecard. Per-hazard contingency table makes "did our forecast
--      skill improve" answerable over time.
--   2. forecast_context() picks up per-feature SPC overlap so the AI draft
--      and operator UI can see "your area sits in MDT" instead of just
--      "today's region-wide top label is MDT."
--   3. Recurring templates — minimal schema + tick RPC + cron so a "morning
--      outlook" can auto-create a draft each day populated with the latest
--      context snapshot.
--   4. Public sharing — public_token + an anon read policy so /f/<token>
--      renders issued/closed forecasts without auth.
--   5. broadcast_message_id link from forecasts → messages so the in-app
--      "Broadcast to subscribers in polygon" action records the fanout.

-- --------------------------------------------------------------------------
-- 1. score_forecast() — add CSI / POD / FAR + false_alarm_hazards.
--
-- Contingency table per spotter-report (LSR) ground truth in the area &
-- window. Per-hazard, mapped against the forecast's hazards[]:
--   hits          (a) = forecast_hazards ∩ observed_hazards
--   misses        (b) = observed_hazards - forecast_hazards
--   false_alarms  (c) = forecast_hazards - observed_hazards
--   POD = a / (a + b);  FAR = c / (a + c);  CSI = a / (a + b + c)
-- Division-by-zero (no obs OR empty forecast) returns null for that ratio.
create or replace function public.score_forecast(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with f as (
    select id, area, hazards, valid_from, valid_until
    from public.forecasts
    where id = p_id
  ),
  warnings as (
    select a.event, a.severity, a.effective, a.expires_at
    from public.nws_alerts a, f
    where a.event ilike '%warning%'
      and a.polygon is not null
      and st_intersects(a.polygon, f.area)
      and (a.effective, coalesce(a.expires_at, a.effective + interval '6 hours'))
          overlaps (f.valid_from, f.valid_until)
  ),
  lsrs as (
    select r.hazard, r.event
    from public.nws_storm_reports r, f
    where r.hazard is not null
      and st_intersects(r.point, f.area)
      and r.occurred_at between f.valid_from and f.valid_until
  ),
  observed_hazards as (
    select distinct hazard from lsrs
  ),
  contingency as (
    select
      (select hazards from f)                                               as forecast_hazards,
      (select coalesce(array_agg(distinct hazard), '{}') from observed_hazards) as observed_hazards,
      (select coalesce(array_agg(distinct hazard) filter (where hazard = any((select hazards from f))), '{}') from observed_hazards) as matched_hazards,
      (select coalesce(array_agg(distinct hazard) filter (where not (hazard = any((select hazards from f)))), '{}') from observed_hazards) as missed_hazards,
      (
        select coalesce(array_agg(h), '{}')
        from unnest((select hazards from f)) as h
        where not exists (select 1 from observed_hazards o where o.hazard = h)
      ) as false_alarm_hazards
  ),
  scores as (
    select
      contingency.forecast_hazards,
      contingency.observed_hazards,
      contingency.matched_hazards,
      contingency.missed_hazards,
      contingency.false_alarm_hazards,
      cardinality(contingency.matched_hazards)      as hits,
      cardinality(contingency.missed_hazards)       as misses,
      cardinality(contingency.false_alarm_hazards)  as false_alarms
    from contingency
  )
  select jsonb_build_object(
    'warnings_in_area',  (select count(*)::int from warnings),
    'warnings_by_event', (
      select coalesce(jsonb_object_agg(event, c), '{}'::jsonb)
      from (select event, count(*)::int as c from warnings group by event) g
    ),
    'lsrs_in_area',      (select count(*)::int from lsrs),
    'lsrs_by_hazard',    (
      select coalesce(jsonb_object_agg(hazard, c), '{}'::jsonb)
      from (select hazard, count(*)::int as c from lsrs group by hazard) g
    ),
    'observed_hazards',    (select observed_hazards    from scores),
    'matched_hazards',     (select matched_hazards     from scores),
    'missed_hazards',      (select missed_hazards      from scores),
    'false_alarm_hazards', (select false_alarm_hazards from scores),
    'hazard_match',        (select hits > 0 from scores),
    'skill', jsonb_build_object(
      'hits',         (select hits         from scores),
      'misses',       (select misses       from scores),
      'false_alarms', (select false_alarms from scores),
      'pod', (
        select case when hits + misses = 0 then null
                    else round((hits::numeric / (hits + misses))::numeric, 3) end
        from scores
      ),
      'far', (
        select case when hits + false_alarms = 0 then null
                    else round((false_alarms::numeric / (hits + false_alarms))::numeric, 3) end
        from scores
      ),
      'csi', (
        select case when hits + misses + false_alarms = 0 then null
                    else round((hits::numeric / (hits + misses + false_alarms))::numeric, 3) end
        from scores
      )
    ),
    'window', (select jsonb_build_object('valid_from', valid_from, 'valid_until', valid_until) from f),
    'scored_at', now()
  );
$$;

-- --------------------------------------------------------------------------
-- 2. forecast_context() — add spc_overlap per day. Replaces the prior
-- definition; signature unchanged so the existing TS caller in
-- app/forecast/actions.ts still works.
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
  v_geog := v_g::geography;
  v_centroid := st_centroid(v_g);

  return jsonb_build_object(
    'area_centroid', jsonb_build_object(
      'type', 'Point',
      'coordinates', jsonb_build_array(st_x(v_centroid), st_y(v_centroid))
    ),
    'spc', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'day_number',    day_number,
        'highest_label', highest_label,
        'issued_at',     issued_at,
        'valid_from',    valid_from,
        'valid_until',   valid_until
      ) order by day_number), '[]'::jsonb)
      from public.spc_outlooks
      where day_number in (1, 2, 3)
    ),
    -- Per-feature SPC overlap with the forecast area. Returns distinct labels
    -- per day for whichever SPC categorical polygons actually intersect the
    -- operator's drawn area — answers "we're under MDT" vs "today's HIGH is
    -- 300 mi east, we're in TSTM".
    'spc_overlap', (
      select coalesce(jsonb_object_agg(day_number::text, labels), '{}'::jsonb)
      from (
        select o.day_number,
               jsonb_agg(distinct feature->'properties'->>'LABEL'
                 order by feature->'properties'->>'LABEL') as labels
        from public.spc_outlooks o,
             jsonb_array_elements(o.geojson->'features') as feature
        where o.day_number in (1, 2, 3)
          and feature->'geometry' is not null
          and st_intersects(
                st_setsrid(st_geomfromgeojson(feature->'geometry'), 4326),
                v_g
              )
          and feature->'properties'->>'LABEL' is not null
        group by o.day_number
      ) g
    ),
    'afd', (
      select jsonb_build_object(
        'wfo',        wfo,
        'issued_at',  issued_at,
        'synopsis',   synopsis,
        'short_term', short_term,
        'ai_summary', ai_summary
      )
      from public.nws_afd
      where issued_at >= now() - interval '24 hours'
      order by issued_at desc
      limit 1
    ),
    'alerts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'event',       event,
        'headline',    headline,
        'ai_summary',  raw->'properties'->>'ai_summary',
        'severity',    severity,
        'effective',   effective,
        'expires_at',  expires_at
      ) order by effective desc), '[]'::jsonb)
      from public.nws_alerts
      where status = 'new'
        and polygon is not null
        and st_intersects(polygon, v_geog)
        and coalesce(expires_at, now()) >= now() - interval '6 hours'
    ),
    'lsrs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'event',       event,
        'hazard',      hazard,
        'magnitude',   magnitude,
        'location',    location,
        'occurred_at', occurred_at
      ) order by occurred_at desc), '[]'::jsonb)
      from public.nws_storm_reports
      where occurred_at >= now() - make_interval(hours => v_lookback)
        and st_intersects(point, v_geog)
    )
  );
end;
$$;

-- --------------------------------------------------------------------------
-- 3. Public sharing — public_token + anon read policy.
alter table public.forecasts
  add column if not exists public_token text unique,
  add column if not exists broadcast_message_id uuid references public.messages(id) on delete set null,
  add column if not exists broadcast_at timestamptz;

create index if not exists forecasts_public_token_idx
  on public.forecasts (public_token)
  where public_token is not null;

-- Anyone (including unauth'd) can read a forecast when the operator has
-- chosen to share it (public_token set) AND it has reached issued/closed.
-- Drafts and ai_drafts stay invisible to the public regardless of token.
create policy "public forecasts_share_read"
  on public.forecasts for select
  to anon, authenticated
  using (
    public_token is not null
    and status in ('issued', 'closed')
  );

-- forecast_area_geojson is currently operator-only. Add a parallel public
-- function keyed on the share token so /f/<token> can render the polygon
-- without exposing the operator-only RPC.
create or replace function public.forecast_public_area_geojson(p_token text)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'type', 'MultiPolygon',
    'coordinates', (st_asgeojson(area::geometry)::jsonb)->'coordinates'
  )
  from public.forecasts
  where public_token = p_token
    and status in ('issued', 'closed');
$$;

revoke all on function public.forecast_public_area_geojson(text) from public;
grant execute on function public.forecast_public_area_geojson(text) to anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 4. Recurring templates.
create table if not exists public.forecast_templates (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null
    references public.operators(user_id) on delete cascade,
  name text not null,
  area geography(MultiPolygon, 4326) not null,
  hazards text[] not null default '{}',
  confidence text check (confidence in ('low','moderate','high')),
  -- Window length of each generated forecast in hours (e.g. 12 = a 12-hour
  -- outlook). The forecast's valid_from = next_run_at, valid_until = +window.
  window_hours int not null default 12,
  -- 'daily' or 'weekly'. RRULE was overkill for the v1 single-knob templates
  -- the operator actually needs ("morning outlook every day at 6 AM CT").
  cadence text not null default 'daily'
    check (cadence in ('daily', 'weekly')),
  hour_of_day int not null default 11 check (hour_of_day between 0 and 23),
  enabled boolean not null default true,
  last_fired_at timestamptz,
  next_run_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists forecast_templates_next_run_idx
  on public.forecast_templates (next_run_at)
  where enabled = true;

alter table public.forecast_templates enable row level security;

create policy "op forecast_templates_all"
  on public.forecast_templates for all
  using (public.is_operator())
  with check (public.is_operator());

-- Compute the next run time based on cadence + hour_of_day. Pure function
-- so the tick + the UI can both call it for previews.
create or replace function public.forecast_template_next_at(
  p_after  timestamptz,
  p_cadence text,
  p_hour    int
) returns timestamptz
language sql
immutable
set search_path = public, extensions
as $$
  with anchor as (
    select date_trunc('day', p_after) + make_interval(hours => greatest(0, least(23, coalesce(p_hour, 11)))) as base
  )
  select case
    when p_cadence = 'weekly' then
      case when (select base from anchor) > p_after
           then (select base from anchor)
           else (select base from anchor) + interval '7 days'
      end
    else  -- 'daily'
      case when (select base from anchor) > p_after
           then (select base from anchor)
           else (select base from anchor) + interval '1 day'
      end
  end;
$$;

-- Create a template from operator-supplied area GeoJSON + knobs. Mirrors
-- forecast_create's geography conversion so the call site doesn't need to
-- worry about PostGIS types.
create or replace function public.forecast_template_create(
  p_name         text,
  p_area         jsonb,
  p_hazards      text[],
  p_confidence   text,
  p_cadence      text,
  p_hour_of_day  int,
  p_window_hours int,
  p_next_run_at  timestamptz
) returns uuid
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_g     geometry;
  v_area  geography;
  v_id    uuid;
begin
  if not public.is_operator() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_g := st_setsrid(st_geomfromgeojson(p_area::text), 4326);
  if v_g is null then
    raise exception 'invalid GeoJSON area';
  end if;
  if st_geometrytype(v_g) = 'ST_Polygon' then
    v_area := st_multi(v_g)::geography;
  elsif st_geometrytype(v_g) = 'ST_MultiPolygon' then
    v_area := v_g::geography;
  else
    raise exception 'area must be Polygon or MultiPolygon, got %', st_geometrytype(v_g);
  end if;

  insert into public.forecast_templates (
    operator_id, name, area, hazards, confidence,
    cadence, hour_of_day, window_hours, next_run_at
  ) values (
    auth.uid(), p_name, v_area, coalesce(p_hazards, '{}'), p_confidence,
    coalesce(p_cadence, 'daily'), coalesce(p_hour_of_day, 11),
    coalesce(p_window_hours, 12), coalesce(p_next_run_at, now() + interval '1 day')
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.forecast_template_create(text, jsonb, text[], text, text, int, int, timestamptz) from public, anon;
grant execute on function public.forecast_template_create(text, jsonb, text[], text, text, int, int, timestamptz) to authenticated, service_role;

-- Fire a single template. Creates a draft forecast populated with the
-- template's area + hazards + a fresh source_refs snapshot, then advances
-- next_run_at. Returns the new forecast id.
create or replace function public.forecast_template_fire(p_template_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_template public.forecast_templates%rowtype;
  v_area_geojson jsonb;
  v_context jsonb;
  v_forecast_id uuid;
  v_valid_from timestamptz;
  v_valid_until timestamptz;
begin
  select * into v_template
  from public.forecast_templates
  where id = p_template_id
  for update;
  if v_template.id is null then
    raise exception 'template not found';
  end if;

  v_valid_from := coalesce(v_template.next_run_at, now());
  v_valid_until := v_valid_from + make_interval(hours => greatest(1, v_template.window_hours));

  -- Marshal the geography back to GeoJSON Polygon/MultiPolygon for both the
  -- forecast_create RPC and the source_refs snapshot. ST_AsGeoJSON returns a
  -- text blob; round-trip through jsonb.
  v_area_geojson := st_asgeojson(v_template.area::geometry)::jsonb;

  -- Context snapshot — same shape as the interactive AI-draft path, minus
  -- the AI invocation. We deliberately do NOT call DeepSeek from cron; the
  -- operator clicks "AI draft" from the form if they want it.
  begin
    select public.forecast_context(v_area_geojson, 24) into v_context;
  exception when others then
    v_context := '{}'::jsonb;
  end;

  insert into public.forecasts (
    operator_id, title, hazards, confidence, area, valid_from, valid_until,
    discussion, source_refs, ai_draft, status
  ) values (
    v_template.operator_id,
    v_template.name || ' — ' || to_char(v_valid_from, 'YYYY-MM-DD'),
    coalesce(v_template.hazards, '{}'),
    v_template.confidence,
    v_template.area,
    v_valid_from,
    v_valid_until,
    null,
    jsonb_build_object('template_id', v_template.id, 'context', v_context),
    null,
    'draft'
  )
  returning id into v_forecast_id;

  update public.forecast_templates
     set last_fired_at = now(),
         next_run_at = public.forecast_template_next_at(now(), cadence, hour_of_day),
         updated_at = now()
   where id = p_template_id;

  return v_forecast_id;
end;
$$;

revoke all on function public.forecast_template_fire(uuid) from public, anon;
grant execute on function public.forecast_template_fire(uuid) to service_role;

-- Cron tick: every 15 min, fire any enabled template whose next_run_at has
-- passed. Idempotent — the template_fire RPC's SELECT … FOR UPDATE prevents
-- concurrent ticks from double-firing the same row.
select cron.schedule(
  'forecast-template-tick',
  '*/15 * * * *',
  $$
  do $body$
  declare
    t record;
  begin
    for t in
      select id
      from public.forecast_templates
      where enabled = true
        and next_run_at <= now()
      order by next_run_at
      limit 50
    loop
      perform public.forecast_template_fire(t.id);
    end loop;
  end
  $body$;
  $$
);
