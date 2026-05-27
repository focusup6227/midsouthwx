-- Spotter participation: per-subscriber report stats + per-report "forwarded
-- to nearby" tracking. Triage UI shows reliability badges inline; popup
-- actions surface a one-tap "forward photo to subscribers within 5 km".

alter table public.telegram_storm_reports
  add column if not exists last_forwarded_at timestamptz,
  add column if not exists forward_count int not null default 0,
  add column if not exists forward_message_id uuid references public.messages(id) on delete set null;

-- Per-subscriber aggregate. Inherits RLS from subscribers + telegram_storm_reports
-- (both operator-only), so unauth'd reads get nothing. View is the simplest
-- shape; if call volume justifies it later we can swap for a materialized
-- view + cron refresh.
create or replace view public.subscriber_spotter_stats as
select
  s.id                                                            as subscriber_id,
  s.display_name,
  s.telegram_username,
  count(r.id)::int                                                as total_reports,
  count(r.id) filter (where r.status = 'verified')::int           as verified_count,
  count(r.id) filter (where r.status = 'promoted')::int           as promoted_count,
  count(r.id) filter (where r.status = 'dismissed')::int          as dismissed_count,
  count(r.id) filter (where r.status = 'new')::int                as new_count,
  max(r.reported_at)                                              as last_reported_at,
  max(r.reported_at) filter (where r.status in ('verified','promoted')) as last_confirmed_at
from public.subscribers s
left join public.telegram_storm_reports r on r.subscriber_id = s.id
group by s.id, s.display_name, s.telegram_username;

-- Views don't carry RLS themselves; selects fall back to the underlying
-- tables' policies. Make explicit anyway so an accidental anon grant on
-- the future doesn't open this.
revoke all on public.subscriber_spotter_stats from public, anon;
grant select on public.subscriber_spotter_stats to authenticated, service_role;

-- Atomic counter bump for forwardReportToNearby — avoids the read-modify-write
-- race a naive client-side increment would expose if two forwards land in
-- the same tick.
create or replace function public.record_storm_report_forward(
  p_report_id uuid,
  p_message_id uuid
) returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.telegram_storm_reports
     set last_forwarded_at = now(),
         forward_count     = coalesce(forward_count, 0) + 1,
         forward_message_id = p_message_id
   where id = p_report_id;
$$;

revoke all on function public.record_storm_report_forward(uuid, uuid) from public, anon;
grant execute on function public.record_storm_report_forward(uuid, uuid) to service_role;
