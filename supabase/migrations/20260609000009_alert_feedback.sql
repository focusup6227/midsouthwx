-- Per-message subscriber feedback so the operator can tune which NWS
-- categories/hazards are useful vs. noise. Captured via the 👍 / 👎 / 💬
-- inline keyboard rows that telegram-send-worker auto-appends to NWS-sourced
-- alert messages. Unique on (message_id, subscriber_id) so a subscriber can
-- change their mind by tapping again — last tap wins.

create table public.alert_feedback (
  id           bigserial primary key,
  message_id   uuid not null references public.messages(id) on delete cascade,
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  sentiment    text not null check (sentiment in ('up', 'down', 'reply')),
  created_at   timestamptz not null default now(),
  unique (message_id, subscriber_id)
);

create index alert_feedback_msg_idx on public.alert_feedback (message_id);
create index alert_feedback_sub_idx on public.alert_feedback (subscriber_id, created_at desc);

alter table public.alert_feedback enable row level security;

-- Operator-only read; writes happen via service_role (webhook bypasses RLS).
create policy "op feedback read"
  on public.alert_feedback
  for select
  using (public.is_operator());
