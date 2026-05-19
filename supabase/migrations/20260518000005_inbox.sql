-- 0005 — conversations, replies, check-in responses

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null unique references public.subscribers(id) on delete cascade,
  last_message_at timestamptz,
  unread_count int not null default 0,
  pinned boolean default false
);

create table public.replies (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  parent_message_id uuid references public.messages(id) on delete set null,
  body text,
  callback_data text,
  telegram_message_id bigint,
  is_distress boolean default false,
  read_at timestamptz,
  received_at timestamptz default now()
);
create index replies_conv_idx on public.replies(conversation_id, received_at desc);
create index replies_unread_idx on public.replies(read_at) where read_at is null;
create index replies_distress_idx on public.replies(is_distress) where is_distress;

create table public.check_in_responses (
  message_id uuid not null references public.messages(id) on delete cascade,
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  response_code text,
  free_text text,
  responded_at timestamptz default now(),
  primary key (message_id, subscriber_id)
);

alter table public.conversations enable row level security;
alter table public.replies enable row level security;
alter table public.check_in_responses enable row level security;

create policy "op conversations" on public.conversations
  for all using (public.is_operator()) with check (public.is_operator());
create policy "op replies" on public.replies
  for all using (public.is_operator()) with check (public.is_operator());
create policy "op checkins" on public.check_in_responses
  for all using (public.is_operator()) with check (public.is_operator());

-- Realtime publication: dashboard subscribes to inserts on replies + delivery_logs.
-- supabase_realtime publication exists by default; add our tables.
alter publication supabase_realtime add table public.replies;
alter publication supabase_realtime add table public.delivery_logs;
alter publication supabase_realtime add table public.outbound_queue;
alter publication supabase_realtime add table public.check_in_responses;
alter publication supabase_realtime add table public.messages;
