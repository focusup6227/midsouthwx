-- Client-side error capture. The dashboard runs unattended on phones during
-- events; when it breaks there is currently zero signal. Browser errors are
-- POSTed to /api/client-errors (session-gated, service-role insert) and
-- surfaced on /health.

create table if not exists public.client_errors (
  id bigserial primary key,
  message text not null,
  stack text,
  url text,
  user_agent text,
  occurred_at timestamptz not null default now()
);

create index if not exists client_errors_occurred_idx
  on public.client_errors (occurred_at desc);

alter table public.client_errors enable row level security;

create policy "op client_errors_select"
  on public.client_errors for select
  using (public.is_operator());

-- Inserts happen via service_role from the API route; no authenticated grants.

-- Prune with the other logs.
select cron.schedule(
  'client-errors-prune',
  '35 3 * * *',
  $$ delete from public.client_errors where occurred_at < now() - interval '30 days'; $$
);
