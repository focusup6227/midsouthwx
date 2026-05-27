-- Phase 4: forecast verification scoring.
--
-- An hourly pg_cron job closes + scores any forecast whose window has
-- elapsed. Score math runs in pure SQL against the existing GIST indexes
-- on nws_alerts.polygon and nws_storm_reports.point — no edge function.
--
-- The structured `verification` jsonb attached to each forecast carries:
--   warnings_in_area     int    — NWS warnings whose polygon intersected
--                                 the forecast area AND whose effective
--                                 window overlapped the forecast window.
--   warnings_by_event    jsonb  — { "Tornado Warning": 2, … }
--   lsrs_in_area         int    — LSRs whose point fell inside the area
--                                 during the forecast window.
--   lsrs_by_hazard       jsonb  — { "tornado": 1, "severe": 4, … }
--   matched_hazards      text[] — forecast hazards that ≥1 LSR confirmed
--   missed_hazards       text[] — LSR hazards that the forecast did NOT
--                                 call out (recall failures)
--   hazard_match         bool   — at least one forecast hazard was matched
--   window               jsonb  — snapshot of the forecast window
--   scored_at            tstz
--
-- Caveat: this is a count-based scorecard, not a probabilistic skill score
-- (no BSS, no CSI). The plan called for counts as v1; if we want CSI/POD/FAR
-- later we extend this function — the schema doesn't need to change.

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
    where a.polygon is not null
      and st_intersects(a.polygon, f.area)
      -- Treat null bounds as open-ended on that side. Direct comparisons
      -- avoid tstzrange's "lower <= upper" precondition (NWS occasionally
      -- emits alerts where effective > expires_at after corrections).
      and (a.expires_at is null or a.expires_at > f.valid_from)
      and (a.effective  is null or a.effective  < f.valid_until)
  ),
  lsrs as (
    select r.hazard, r.event, r.occurred_at
    from public.nws_storm_reports r, f
    where st_intersects(r.point, f.area)
      and r.occurred_at >= f.valid_from
      and r.occurred_at <= f.valid_until
  ),
  warnings_by_event as (
    select event, count(*) as c from warnings group by event
  ),
  lsrs_by_hazard as (
    select hazard, count(*) as c from lsrs
    where hazard is not null and hazard <> 'other'
    group by hazard
  )
  -- matched/missed/hazard_match are computed via inline subqueries against
  -- `lsrs_by_hazard` (which already filters out null + 'other' hazards) so
  -- we don't need a separate "lsr_hazards" CTE. An earlier version used a
  -- top-level CTE for that, but Postgres errored with "missing FROM-clause
  -- entry for table 'lsr_hazards'" when the scalar subquery referenced it
  -- — scalar subqueries see the outer table list but not sibling CTEs in
  -- a way that lets you join against them via comma syntax.
  select jsonb_build_object(
    'scored_at', now(),
    'window', jsonb_build_object('from', f.valid_from, 'until', f.valid_until),
    'warnings_in_area', (select count(*) from warnings),
    'warnings_by_event', coalesce((select jsonb_object_agg(event, c) from warnings_by_event), '{}'::jsonb),
    'lsrs_in_area', (select count(*) from lsrs),
    'lsrs_by_hazard', coalesce((select jsonb_object_agg(hazard, c) from lsrs_by_hazard), '{}'::jsonb),
    'matched_hazards', coalesce((
      select array_agg(h order by h)
      from unnest(f.hazards) h
      where h in (select hazard from lsrs_by_hazard)
    ), '{}'::text[]),
    'missed_hazards', coalesce((
      select array_agg(hazard order by hazard)
      from lsrs_by_hazard
      where hazard <> all(f.hazards)
    ), '{}'::text[]),
    'hazard_match', exists (
      select 1 from lsrs_by_hazard
      where hazard = any(f.hazards)
    )
  )
  from f;
$$;

revoke all on function public.score_forecast(uuid) from public, anon;
grant execute on function public.score_forecast(uuid) to authenticated, service_role;

-- Operator-triggered rescore for the "Score now" button on the detail page.
-- Works whether the forecast window has closed or not — useful for sanity
-- checks during an event and for testing on freshly created forecasts.
-- Only flips status to 'closed' when the window has actually elapsed.
create or replace function public.forecast_rescore(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_result jsonb;
  v_window_closed boolean;
begin
  if not public.is_operator() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_result := public.score_forecast(p_id);
  if v_result is null then
    raise exception 'forecast % not found', p_id;
  end if;

  select valid_until < now() into v_window_closed
  from public.forecasts where id = p_id;

  update public.forecasts
     set verification = v_result,
         status = case when v_window_closed then 'closed' else status end,
         updated_at = now()
   where id = p_id;

  return v_result;
end;
$$;

revoke all on function public.forecast_rescore(uuid) from public, anon;
grant execute on function public.forecast_rescore(uuid) to authenticated, service_role;

-- Hourly cron: close + score forecasts whose window has elapsed. Runs at
-- :07 of every hour so we're not bunched at the top with other workers
-- (send-worker is :*, spc-poll is :*/30, nws-alerts-prune is 3:15 daily).
select cron.schedule(
  'forecast-verify',
  '7 * * * *',
  $$
  update public.forecasts f
     set verification = public.score_forecast(f.id),
         status = 'closed',
         updated_at = now()
   where f.valid_until < now()
     and f.verification is null;
  $$
);
