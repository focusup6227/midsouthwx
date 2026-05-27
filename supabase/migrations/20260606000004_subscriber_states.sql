-- One-row-per-subscriber conversational state for the Telegram bot. Lets us
-- replace slash-command-driven UX with guided flows: the bot tells the user
-- "reply with your current address" and remembers what their next message is
-- supposed to be. Auto-expires after 10 minutes so a stale flow never silently
-- hijacks a plain chat reply.

create table public.subscriber_states (
  subscriber_id uuid primary key references public.subscribers(id) on delete cascade,
  awaiting      text,                              -- 'address' | 'quiet_start' | … | null
  meta          jsonb not null default '{}'::jsonb,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);

create index subscriber_states_expires_idx
  on public.subscriber_states (expires_at)
  where awaiting is not null;

alter table public.subscriber_states enable row level security;

-- Service-role only. The webhook (running as service_role) is the only writer
-- and reader — there's no need to expose this to the operator dashboard.
revoke all on table public.subscriber_states from public, anon, authenticated;
grant all on table public.subscriber_states to service_role;

-- Nightly prune: drop rows whose awaiting flag has been null for >7d. Keeps
-- the table tiny since the bot upserts one row per active subscriber.
select cron.schedule(
  'subscriber-states-prune',
  '25 4 * * *',
  $$
  delete from public.subscriber_states
  where awaiting is null
    and updated_at < now() - interval '7 days';
  $$
);
