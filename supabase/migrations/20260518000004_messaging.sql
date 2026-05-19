-- 0004 — templates, messages, outbound queue, delivery logs

create type message_source as enum ('manual', 'scheduled', 'nws', 'checkin');
create type message_status as enum (
  'draft', 'pending_approval', 'queued', 'sending', 'sent', 'failed', 'cancelled'
);
create type outbound_status as enum ('pending', 'sending', 'sent', 'failed', 'skipped');
create type delivery_event  as enum ('queued', 'sent', 'delivered', 'failed', 'read');

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text,
  body_md text not null,
  default_quick_replies jsonb,
  created_at timestamptz default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  body_md text not null,
  body_rendered text,
  source message_source not null default 'manual',
  status message_status not null default 'draft',
  audience_spec jsonb not null,
  quick_replies jsonb,
  template_id uuid references public.templates(id) on delete set null,
  nws_alert_id uuid,  -- FK added in 0006 once nws_alerts exists
  recipient_count int default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  sent_at timestamptz
);
create index messages_status_idx on public.messages(status);
create index messages_created_idx on public.messages(created_at desc);

create table public.outbound_queue (
  id bigserial primary key,
  message_id uuid not null references public.messages(id) on delete cascade,
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  status outbound_status not null default 'pending',
  telegram_message_id bigint,
  attempts int not null default 0,
  last_error text,
  send_after timestamptz default now(),
  locked_at timestamptz,
  locked_by text,
  sent_at timestamptz,
  created_at timestamptz default now()
);
create index outbound_due_idx on public.outbound_queue (status, send_after)
  where status = 'pending';
create unique index outbound_one_per_msg on public.outbound_queue (message_id, subscriber_id);

create table public.delivery_logs (
  id bigserial primary key,
  outbound_id bigint references public.outbound_queue(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  subscriber_id uuid references public.subscribers(id),
  event delivery_event not null,
  meta jsonb,
  occurred_at timestamptz default now()
);
create index delivery_logs_msg_idx on public.delivery_logs(message_id, occurred_at desc);

alter table public.templates enable row level security;
alter table public.messages enable row level security;
alter table public.outbound_queue enable row level security;
alter table public.delivery_logs enable row level security;

create policy "op templates"  on public.templates     for all    using (public.is_operator()) with check (public.is_operator());
create policy "op messages"   on public.messages      for all    using (public.is_operator()) with check (public.is_operator());
create policy "op queue read" on public.outbound_queue for select using (public.is_operator());
create policy "op delivery"   on public.delivery_logs for select using (public.is_operator());
-- Worker writes happen via service_role and bypass RLS.
