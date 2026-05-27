-- Operator can attach a GIF / image / video to a compose message. The send
-- worker switches from sendMessage to sendAnimation/sendPhoto/sendVideo when
-- media_url is set, with body_md passed as the caption.
--
-- Bucket `compose-media` holds the uploaded files. Public read so Telegram's
-- servers can fetch them via URL; only operators can write.

alter table public.messages
  add column if not exists media_url  text,
  add column if not exists media_type text;
-- media_type ∈ {animation, photo, video, document}. Enforced in app layer.

-- Add the storage bucket (idempotent). Realtime/Storage tables live in the
-- `storage` schema; insert directly so the bucket exists locally + remotely.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'compose-media',
  'compose-media',
  true,
  52428800,                                                -- 50 MB, Telegram's animation limit
  array[
    'image/gif',
    'image/png',
    'image/jpeg',
    'image/webp',
    'video/mp4',
    'video/quicktime'
  ]
)
on conflict (id) do nothing;

-- Public-read so Telegram can fetch the URL. Operator-only write/update/delete.
create policy "compose-media public read"
  on storage.objects for select
  using (bucket_id = 'compose-media');

create policy "compose-media operator write"
  on storage.objects for insert
  with check (bucket_id = 'compose-media' and public.is_operator());

create policy "compose-media operator update"
  on storage.objects for update
  using (bucket_id = 'compose-media' and public.is_operator());

create policy "compose-media operator delete"
  on storage.objects for delete
  using (bucket_id = 'compose-media' and public.is_operator());

-- Extend claim_outbound_batch so the send worker can read media fields and
-- choose sendAnimation/Photo/Video instead of sendMessage.
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
  media_type        text
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
    m.media_type
  from claimed c
  join public.messages m on m.id = c.message_id
  join public.subscribers s on s.id = c.subscriber_id
  left join public.nws_alerts a on a.id = m.nws_alert_id;
end$$;

revoke all on function public.claim_outbound_batch(int, text, int) from public, anon, authenticated;
grant execute on function public.claim_outbound_batch(int, text, int) to service_role;
