-- Inbox operator replies: direction on replies + record_conversation_outbound RPC.

alter table public.replies
  add column if not exists direction text not null default 'inbound'
    check (direction in ('inbound', 'outbound')),
  add column if not exists operator_user_id uuid references auth.users(id) on delete set null;

comment on column public.replies.direction is 'inbound = subscriber/Telegram; outbound = operator dashboard reply';
comment on column public.replies.operator_user_id is 'auth.uid() when direction = outbound';

-- Tighten RLS: operators read/update; inserts only via service_role (webhook) or record_conversation_outbound RPC.
drop policy if exists "op replies" on public.replies;

create policy "op replies select" on public.replies
  for select using (public.is_operator());

create policy "op replies update" on public.replies
  for update using (public.is_operator()) with check (public.is_operator());

create or replace function public.record_conversation_outbound(
  p_conversation_id uuid,
  p_body text,
  p_telegram_message_id bigint
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscriber_id uuid;
  v_reply_id uuid;
  v_body text := nullif(trim(p_body), '');
begin
  if not public.is_operator() then
    raise exception 'not authorized';
  end if;

  if v_body is null then
    raise exception 'empty message';
  end if;

  if char_length(v_body) > 4096 then
    raise exception 'message too long';
  end if;

  select c.subscriber_id into v_subscriber_id
  from public.conversations c
  where c.id = p_conversation_id;

  if v_subscriber_id is null then
    raise exception 'conversation not found';
  end if;

  insert into public.replies (
    conversation_id,
    subscriber_id,
    body,
    direction,
    operator_user_id,
    telegram_message_id,
    received_at,
    read_at
  ) values (
    p_conversation_id,
    v_subscriber_id,
    v_body,
    'outbound',
    auth.uid(),
    p_telegram_message_id,
    now(),
    now()
  )
  returning id into v_reply_id;

  update public.conversations
  set last_message_at = now()
  where id = p_conversation_id;

  return v_reply_id;
end$$;

revoke all on function public.record_conversation_outbound(uuid, text, bigint) from public, anon;
grant execute on function public.record_conversation_outbound(uuid, text, bigint) to authenticated, service_role;

-- Only mark inbound rows unread when operator opens thread.
create or replace function public.mark_conversation_read(conv_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.replies
  set read_at = now()
  where conversation_id = conv_id
    and read_at is null
    and direction = 'inbound';

  update public.conversations
  set unread_count = 0
  where id = conv_id;
$$;
