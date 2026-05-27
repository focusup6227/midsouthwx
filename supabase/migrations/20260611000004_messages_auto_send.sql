-- Auto-send with operator-override window for PDS / Tornado Emergency.
--
-- When the nws-dispatcher detects a Particularly Dangerous Situation or a
-- Tornado Emergency, it now queues the message as pending_approval AND
-- stamps `auto_send_at = now() + 30 seconds`. Two paths can promote the
-- message to queued:
--
--   1. Client UI: NwsApproveButtons renders a countdown for any pending
--      row that has auto_send_at; when the countdown hits zero (and the
--      operator hasn't tapped Cancel) the client calls the existing
--      approveNwsMessage server action. Operator can Cancel at any moment.
--
--   2. Server fallback: promote_auto_send_messages() runs at the top of
--      each nws-dispatcher tick. If the operator's browser is closed or
--      their internet is down, the message still flushes within ~60 s of
--      the auto_send_at moment (the dispatcher cron cadence). Belt and
--      suspenders for life-safety alerts.
--
-- The 30 s window is deliberately short: PDS/TorE is the rarest, most
-- urgent class of NWS warning. Any longer and the operator override loses
-- meaning for the people receiving it.

alter table public.messages
  add column if not exists auto_send_at timestamptz;

comment on column public.messages.auto_send_at is
  'Set by nws-dispatcher for PDS/TorE auto-send. Operator may cancel before this moment; otherwise the message promotes from pending_approval to queued.';

-- Partial index: only pending_approval rows with a scheduled auto-send moment
-- need to be visible to the promote scan. Keeps the index tiny — even during
-- an outbreak we'd be talking single-digit rows here.
create index if not exists messages_auto_send_due_idx
  on public.messages (auto_send_at)
  where status = 'pending_approval' and auto_send_at is not null;

-- Promote any pending_approval message whose auto_send_at has elapsed.
-- Idempotent because enqueue_message_system inserts via the unique
-- outbound_queue (message_id, subscriber_id) constraint and the status
-- transition guards against double-fire.
--
-- Returns the IDs of messages it actually promoted so the caller can log.
create or replace function public.promote_auto_send_messages()
returns table(message_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  for v_id in
    select id
      from public.messages
      where status = 'pending_approval'
        and auto_send_at is not null
        and auto_send_at <= now()
      for update skip locked
  loop
    perform public.enqueue_message_system(v_id);
    update public.messages
      set auto_send_at = null
      where id = v_id;
    message_id := v_id;
    return next;
  end loop;
end$$;

revoke all on function public.promote_auto_send_messages() from public, anon, authenticated;
grant execute on function public.promote_auto_send_messages() to service_role;
