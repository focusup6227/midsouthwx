-- Track when home_location was last refreshed, so the send worker can nudge
-- subscribers whose pin is going stale (>48 h) when a convective warning
-- lands. Backfills existing rows from updated_at (close enough — most older
-- subscribers haven't moved their home pin since signup).
--
-- The send worker doesn't read home_location_updated_at directly; instead
-- we extend claim_outbound_batch with a boolean `home_stale` so the worker
-- gets a precomputed flag and doesn't repeat the freshness check per row.

alter table public.subscribers
  add column if not exists home_location_updated_at timestamptz;

update public.subscribers
   set home_location_updated_at = updated_at
 where home_location_updated_at is null
   and home_location is not null;

comment on column public.subscribers.home_location_updated_at is
  'Last time home_location was set or refreshed. Used by the send worker to nudge stale pins (>48 h) when a convective warning lands.';

-- Extend claim_outbound_batch to surface home_stale + a flag for live-share
-- so the worker can suppress the nudge while the subscriber is mid-share.
-- Mirrors the column add-on pattern from 20260606000007_message_media.sql
-- and 20260609000010_claim_outbound_subscriber_location.sql.

drop function if exists public.claim_outbound_batch(int, text, int);

create function public.claim_outbound_batch(
  p_limit int,
  p_locked_by text,
  p_lock_ttl_sec int
)
returns table(
  id                bigint,
  message_id        uuid,
  subscriber_id     uuid,
  attempts          int,
  body_rendered     text,
  quick_replies     jsonb,
  telegram_chat_id  bigint,
  message_source    message_source,
  nws_event         text,
  alert_preferences jsonb,
  quiet_hours       jsonb,
  media_url         text,
  media_type        text,
  subscriber_lon    double precision,
  subscriber_lat    double precision,
  home_stale        boolean,
  live_sharing      boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := now();
begin
  return query
  with claimable as (
    select q.id
    from public.outbound_queue q
    where q.status = 'pending'
      and q.send_after <= v_now
      and (q.locked_at is null or q.locked_at < v_now - make_interval(secs => p_lock_ttl_sec))
    order by q.send_after
    limit p_limit
    for update of q skip locked
  ),
  claimed as (
    update public.outbound_queue q
    set status = 'sending',
        locked_at = v_now,
        locked_by = p_locked_by
    from claimable c
    where q.id = c.id
    returning q.id, q.message_id, q.subscriber_id, q.attempts
  )
  select
    c.id,
    c.message_id,
    c.subscriber_id,
    c.attempts,
    coalesce(m.body_rendered, m.body_md) as body_rendered,
    m.quick_replies,
    s.telegram_chat_id,
    m.source as message_source,
    a.event as nws_event,
    s.alert_preferences,
    s.quiet_hours,
    m.media_url,
    m.media_type,
    st_x((coalesce(s.location, s.home_location))::geometry) as subscriber_lon,
    st_y((coalesce(s.location, s.home_location))::geometry) as subscriber_lat,
    (
      s.home_location is not null
      and (
        s.home_location_updated_at is null
        or s.home_location_updated_at < v_now - interval '48 hours'
      )
    ) as home_stale,
    (s.current_location_source = 'telegram_live') as live_sharing
  from claimed c
  join public.messages m on m.id = c.message_id
  join public.subscribers s on s.id = c.subscriber_id
  left join public.nws_alerts a on a.id = m.nws_alert_id;
end$$;

revoke all on function public.claim_outbound_batch(int, text, int) from public, anon, authenticated;
grant execute on function public.claim_outbound_batch(int, text, int) to service_role;
