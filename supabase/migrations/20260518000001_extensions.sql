-- 0001 — extensions, schemas, operator identity

create extension if not exists postgis;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto;

-- Private schema for security-definer helpers and admin functions.
-- Not exposed via the Data API.
create schema if not exists private;
revoke all on schema private from anon, authenticated;

-- One row per operator. With magic-link to a single email, this table has exactly one row.
create table public.operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  telegram_chat_id bigint,
  created_at timestamptz default now()
);
alter table public.operators enable row level security;

create policy "operator reads self"
  on public.operators for select
  using (user_id = auth.uid());

create policy "operator updates self"
  on public.operators for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- is_operator() runs as SECURITY INVOKER. The select policy above ensures
-- auth.uid() can see its own row; if it's there, the caller is the operator.
-- Keeping this INVOKER avoids putting a privileged function in `public`.
create or replace function public.is_operator() returns boolean
language sql stable as $$
  select exists (select 1 from public.operators where user_id = auth.uid());
$$;
