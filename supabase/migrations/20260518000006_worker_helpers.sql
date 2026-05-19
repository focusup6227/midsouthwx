-- 0006 — RPC helpers used by Edge Functions and the dashboard

-- Atomically claim a batch of pending outbound rows. Joins subscribers and
-- message bodies so the worker has everything it needs in one row.
-- locked_at acts as a TTL: if a worker dies, claims older than p_lock_ttl_sec
-- become eligible again.
create or replace function public.claim_outbound_batch(
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
  telegram_chat_id bigint
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
    s.telegram_chat_id
  from claimed c
  join public.messages m on m.id = c.message_id
  join public.subscribers s on s.id = c.subscriber_id;
end$$;

revoke all on function public.claim_outbound_batch(int, text, int) from public, anon, authenticated;
grant execute on function public.claim_outbound_batch(int, text, int) to service_role;

-- Conversation unread counter (called from webhook).
create or replace function public.increment_unread(conv_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.conversations
  set unread_count = unread_count + 1,
      last_message_at = now()
  where id = conv_id;
$$;

revoke all on function public.increment_unread(uuid) from public, anon;
grant execute on function public.increment_unread(uuid) to service_role, authenticated;

-- Mark a conversation read (called from dashboard when operator opens a thread).
create or replace function public.mark_conversation_read(conv_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.replies
  set read_at = now()
  where conversation_id = conv_id and read_at is null;

  update public.conversations
  set unread_count = 0
  where id = conv_id;
$$;

grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- Enqueue an outbound batch atomically from a message + audience spec.
-- The dashboard server action uses this so preview-count and queued-count
-- can never disagree.
create or replace function public.enqueue_message(p_message_id uuid)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_spec jsonb;
  v_count int;
begin
  if not public.is_operator() then
    raise exception 'not authorized';
  end if;

  select audience_spec into v_spec from public.messages where id = p_message_id;
  if v_spec is null then
    raise exception 'message not found';
  end if;

  insert into public.outbound_queue (message_id, subscriber_id)
  select p_message_id, ra.subscriber_id
  from public.resolve_audience(v_spec) ra
  on conflict (message_id, subscriber_id) do nothing;

  select count(*)::int into v_count
  from public.outbound_queue
  where message_id = p_message_id;

  update public.messages
  set status = 'queued',
      recipient_count = v_count
  where id = p_message_id;

  return v_count;
end$$;

grant execute on function public.enqueue_message(uuid) to authenticated;
