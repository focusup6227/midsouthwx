-- Expose the subscriber's point location through claim_outbound_batch so the
-- send worker can compute per-recipient time-to-impact for convective warnings.
-- Mirrors the column add-on pattern from 20260606000007_message_media.sql.

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
  subscriber_lat    double precision
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
    -- Prefer the live location (s.location) when present; fall back to
    -- s.home_location (set during /where flow). NULL when neither is set —
    -- worker skips the per-recipient impact prefix for those subscribers.
    st_x((coalesce(s.location, s.home_location))::geometry) as subscriber_lon,
    st_y((coalesce(s.location, s.home_location))::geometry) as subscriber_lat
  from claimed c
  join public.messages m on m.id = c.message_id
  join public.subscribers s on s.id = c.subscriber_id
  left join public.nws_alerts a on a.id = m.nws_alert_id;
end$$;

revoke all on function public.claim_outbound_batch(int, text, int) from public, anon, authenticated;
grant execute on function public.claim_outbound_batch(int, text, int) to service_role;
