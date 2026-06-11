-- Recover outbound rows stranded in 'sending' by a dead worker.
--
-- claim_outbound_batch claims rows by flipping status pending→sending under
-- a lock. Every failure path in the send worker resets status to 'pending'
-- (nulling locked_at) — but if the worker process dies between claiming and
-- updating (Edge Function wall-clock kill, crash, deploy), its rows stay
-- 'sending' forever: the claim CTE only matched status='pending', so the
-- lock-TTL clause could never fire (pending rows always have locked_at
-- null). Net effect: those subscribers silently never receive that alert.
--
-- Fix: also claim 'sending' rows whose lock has been held longer than the
-- TTL, counting the takeover as an attempt so a row that repeatedly kills
-- workers (e.g. a poison payload) still converges to 'failed' instead of
-- looping forever. Body unchanged otherwise (see
-- 20260610000001_home_location_updated_at.sql).

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
    select q.id, (q.status = 'sending') as is_takeover
    from public.outbound_queue q
    where
      (
        q.status = 'pending'
        and q.send_after <= v_now
        and (q.locked_at is null or q.locked_at < v_now - make_interval(secs => p_lock_ttl_sec))
      )
      or (
        -- Stale 'sending' row: a previous worker claimed it and died before
        -- resolving it. Reclaimable once its lock TTL has lapsed.
        q.status = 'sending'
        and q.locked_at is not null
        and q.locked_at < v_now - make_interval(secs => p_lock_ttl_sec)
      )
    order by q.send_after
    limit p_limit
    for update of q skip locked
  ),
  claimed as (
    update public.outbound_queue q
    set status = 'sending',
        locked_at = v_now,
        locked_by = p_locked_by,
        attempts = q.attempts + (case when c.is_takeover then 1 else 0 end)
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
    -- coalesce: a never-shared subscriber has a null current_location_source,
    -- and `null = 'telegram_live'` is null — callers expect a real boolean.
    coalesce(s.current_location_source = 'telegram_live', false) as live_sharing
  from claimed c
  join public.messages m on m.id = c.message_id
  join public.subscribers s on s.id = c.subscriber_id
  left join public.nws_alerts a on a.id = m.nws_alert_id;
end$$;

revoke all on function public.claim_outbound_batch(int, text, int) from public, anon, authenticated;
grant execute on function public.claim_outbound_batch(int, text, int) to service_role;

-- The hot path already has outbound_due_idx (partial on 'pending'); give the
-- recovery scan its own narrow partial index. 'sending' rows number at most
-- a few batches, so this stays tiny.
create index if not exists outbound_stale_sending_idx
  on public.outbound_queue (locked_at)
  where status = 'sending';
