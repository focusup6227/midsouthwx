-- Subscriber alert preferences + quiet hours (Track 2).

alter table public.subscribers
  add column if not exists alert_preferences jsonb not null default '{
    "warnings": true,
    "watches": true,
    "advisories": true,
    "statements": false
  }'::jsonb,
  add column if not exists quiet_hours jsonb;

comment on column public.subscribers.alert_preferences is
  'JSON: warnings, watches, advisories, statements (bool). NWS auto-alerts only.';
comment on column public.subscribers.quiet_hours is
  'JSON: { enabled, start "HH:MM", end "HH:MM", timezone "America/Chicago" }. Defers non-warnings.';

-- Classify NWS event text for preference matching.
create or replace function public.nws_event_category(p_event text)
returns text
language sql
immutable
as $$
  select case
    when p_event ilike '%warning%' then 'warnings'
    when p_event ilike '%watch%' then 'watches'
    when p_event ilike '%advisory%' then 'advisories'
    when p_event ilike '%statement%' then 'statements'
    else 'other'
  end;
$$;

create or replace function public.subscriber_wants_nws_event(
  p_subscriber_id uuid,
  p_event text
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (
      select (s.alert_preferences ->> public.nws_event_category(p_event))::boolean
      from public.subscribers s
      where s.id = p_subscriber_id
        and s.status = 'active'
    ),
    true
  );
$$;

revoke all on function public.nws_event_category(text) from public, anon;
grant execute on function public.nws_event_category(text) to authenticated, service_role;

revoke all on function public.subscriber_wants_nws_event(uuid, text) from public, anon;
grant execute on function public.subscriber_wants_nws_event(uuid, text) to authenticated, service_role;

-- Enqueue with NWS preference filtering (manual/checkin/scheduled unchanged).
create or replace function public.enqueue_message_system(p_message_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spec jsonb;
  v_source message_source;
  v_nws_event text;
  v_count int;
begin
  select m.audience_spec, m.source, a.event
  into v_spec, v_source, v_nws_event
  from public.messages m
  left join public.nws_alerts a on a.id = m.nws_alert_id
  where m.id = p_message_id;

  if v_spec is null then
    raise exception 'message not found';
  end if;

  if v_source = 'nws' and v_nws_event is not null then
    insert into public.outbound_queue (message_id, subscriber_id)
    select p_message_id, ra.subscriber_id
    from public.resolve_audience(v_spec) ra
    where public.subscriber_wants_nws_event(ra.subscriber_id, v_nws_event)
    on conflict (message_id, subscriber_id) do nothing;
  else
    insert into public.outbound_queue (message_id, subscriber_id)
    select p_message_id, ra.subscriber_id
    from public.resolve_audience(v_spec) ra
    on conflict (message_id, subscriber_id) do nothing;
  end if;

  select count(*)::int into v_count
  from public.outbound_queue
  where message_id = p_message_id;

  update public.messages
  set status = 'queued',
      recipient_count = v_count
  where id = p_message_id;

  return v_count;
end$$;

-- Operator enqueue (same NWS filter).
create or replace function public.enqueue_message(p_message_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spec jsonb;
  v_source message_source;
  v_nws_event text;
  v_count int;
begin
  if not public.is_operator() then
    raise exception 'not authorized';
  end if;

  select m.audience_spec, m.source, a.event
  into v_spec, v_source, v_nws_event
  from public.messages m
  left join public.nws_alerts a on a.id = m.nws_alert_id
  where m.id = p_message_id;

  if v_spec is null then
    raise exception 'message not found';
  end if;

  if v_source = 'nws' and v_nws_event is not null then
    insert into public.outbound_queue (message_id, subscriber_id)
    select p_message_id, ra.subscriber_id
    from public.resolve_audience(v_spec) ra
    where public.subscriber_wants_nws_event(ra.subscriber_id, v_nws_event)
    on conflict (message_id, subscriber_id) do nothing;
  else
    insert into public.outbound_queue (message_id, subscriber_id)
    select p_message_id, ra.subscriber_id
    from public.resolve_audience(v_spec) ra
    on conflict (message_id, subscriber_id) do nothing;
  end if;

  select count(*)::int into v_count
  from public.outbound_queue
  where message_id = p_message_id;

  update public.messages
  set status = 'queued',
      recipient_count = v_count
  where id = p_message_id;

  return v_count;
end$$;

-- Claim batch includes prefs + message context for quiet-hour deferral in send-worker.
-- Must drop first: Postgres cannot change RETURNS TABLE columns via CREATE OR REPLACE.
drop function if exists public.claim_outbound_batch(int, text, int);

create function public.claim_outbound_batch(
  p_limit int,
  p_locked_by text,
  p_lock_ttl_sec int
)
returns table(
  id bigint,
  message_id uuid,
  subscriber_id uuid,
  attempts int,
  body_rendered text,
  quick_replies jsonb,
  telegram_chat_id bigint,
  message_source message_source,
  nws_event text,
  alert_preferences jsonb,
  quiet_hours jsonb
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
    s.quiet_hours
  from claimed c
  join public.messages m on m.id = c.message_id
  join public.subscribers s on s.id = c.subscriber_id
  left join public.nws_alerts a on a.id = m.nws_alert_id;
end$$;

revoke all on function public.claim_outbound_batch(int, text, int) from public, anon, authenticated;
grant execute on function public.claim_outbound_batch(int, text, int) to service_role;

revoke all on function public.enqueue_message_system(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_message_system(uuid) to service_role;

revoke all on function public.enqueue_message(uuid) from public, anon;
grant execute on function public.enqueue_message(uuid) to authenticated, service_role;
