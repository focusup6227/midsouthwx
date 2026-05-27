-- Post-event recap: when a warning expires (or is cancelled), the
-- event-recap edge fn sends a one-shot summary DM to subscribers who
-- received the original alert. Adds:
--   1. recap_sent_at on nws_alerts — debounce + audit, set when the recap
--      message is enqueued so the cron job doesn't double-send.
--   2. 'recap' value on message_source enum — distinguishes recap rows from
--      ad-hoc operator broadcasts on /alerts and from raw NWS sends in
--      delivery analytics.
--
-- Note: Postgres won't let us ALTER TYPE ADD VALUE and use the new value
-- in the same migration (the new label isn't committed until the txn
-- ends). The enqueue path and worker don't reference 'recap' at the SQL
-- level — they read it via supabase-js as a string — so this single
-- migration is safe.

alter table public.nws_alerts
  add column if not exists recap_sent_at timestamptz;

comment on column public.nws_alerts.recap_sent_at is
  'Set by event-recap when a post-event summary has been queued. NULL means recap not yet sent.';

create index if not exists nws_alerts_recap_pending_idx
  on public.nws_alerts (expires_at)
  where recap_sent_at is null
    and status in ('expired', 'cancelled');

alter type public.message_source add value if not exists 'recap';

-- LSRs that landed inside the alert's polygon during its active window.
-- Used by event-recap to build the "what actually happened" summary lines.
-- Returns up to 8 reports, newest first — Telegram message stays scannable.

create or replace function public.event_recap_lsrs(p_alert_id uuid)
returns table(
  id text,
  event text,
  hazard text,
  magnitude text,
  location text,
  occurred_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with a as (
    select polygon, effective, expires_at
    from public.nws_alerts
    where id = p_alert_id
  )
  select r.id, r.event, r.hazard, r.magnitude, r.location, r.occurred_at
  from public.nws_storm_reports r
  cross join a
  where a.polygon is not null
    and st_intersects(r.point, a.polygon)
    and r.occurred_at >= coalesce(a.effective, a.expires_at - interval '2 hours')
    and r.occurred_at <= coalesce(a.expires_at + interval '30 minutes', now())
  order by r.occurred_at desc
  limit 8;
$$;

revoke all on function public.event_recap_lsrs(uuid) from public, anon;
grant execute on function public.event_recap_lsrs(uuid) to authenticated, service_role;
