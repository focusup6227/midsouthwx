-- Backfill expires_at for alerts the issuing office shipped without one.
--
-- Problem: NWS sometimes omits `ends` on Special Weather Statements, MDs,
-- and some advisories. LibreWxR's CAP feed has the same gap. Queries that
-- filter `(expires_at is null or expires_at > now())` treat these as
-- perpetually active — they pile up in radar polygon counts and on the
-- /nws page until the 90-day blanket prune.
--
-- Strategy: a sweeper cron runs every 5 min and fills expires_at on stale
-- null-expires rows using per-event-type TTL defaults that match NWS
-- issuance norms. A 30-min grace window lets the issuing office amend the
-- alert with an actual expiration before we backfill.

create or replace function public.default_alert_ttl(p_event text)
returns interval
language sql
immutable
as $$
  select case
    when p_event is null then interval '2 hours'
    -- Short-duration warnings (typically 30-45 min, re-issued as needed).
    when lower(p_event) like '%tornado emergency%'        then interval '1 hour'
    when lower(p_event) like '%tornado warning%'          then interval '1 hour'
    when lower(p_event) like '%severe thunderstorm warning%' then interval '1 hour'
    when lower(p_event) like '%special marine warning%'   then interval '2 hours'
    -- Floods can run for many hours / days.
    when lower(p_event) like '%flash flood warning%'      then interval '6 hours'
    when lower(p_event) like '%flood warning%'            then interval '12 hours'
    -- Watches: NWS issues with 6-8h validity windows.
    when lower(p_event) like '%watch%'                    then interval '8 hours'
    -- Mesoscale Discussions: short shelf life, usually superseded quickly.
    when lower(p_event) like '%mesoscale discussion%'     then interval '2 hours'
    -- Special Weather Statements: short, often used for sub-warning impacts.
    when lower(p_event) like '%special weather statement%' then interval '90 minutes'
    -- General statements / outlooks: medium-term context.
    when lower(p_event) like '%outlook%'                  then interval '6 hours'
    when lower(p_event) like '%statement%'                then interval '6 hours'
    when lower(p_event) like '%advisory%'                 then interval '6 hours'
    else interval '2 hours'
  end;
$$;

revoke all on function public.default_alert_ttl(text) from public;
grant execute on function public.default_alert_ttl(text) to authenticated, service_role;

-- Sweeper: fill expires_at on stale null-expires rows across both alert
-- tables. Returns the total number of rows touched (for telemetry).
create or replace function public.fill_default_expires_at()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  nws_updated int;
  cap_updated int;
begin
  update public.nws_alerts
  set expires_at = ingested_at + public.default_alert_ttl(event)
  where expires_at is null
    and ingested_at < now() - interval '30 minutes';
  get diagnostics nws_updated = row_count;

  update public.cap_alerts
  set expires_at = ingested_at + public.default_alert_ttl(parsed_event)
  where expires_at is null
    and ingested_at < now() - interval '30 minutes';
  get diagnostics cap_updated = row_count;

  return nws_updated + cap_updated;
end$$;

revoke all on function public.fill_default_expires_at() from public, anon, authenticated;
grant execute on function public.fill_default_expires_at() to service_role;

-- Cron: run every 5 minutes. Drop an existing schedule (idempotent re-apply).
select cron.unschedule('fill-default-expires') where exists (
  select 1 from cron.job where jobname = 'fill-default-expires'
);

select cron.schedule(
  'fill-default-expires',
  '*/5 * * * *',
  $$ select public.fill_default_expires_at(); $$
);
