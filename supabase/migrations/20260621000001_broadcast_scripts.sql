-- Broadcast script library: every script the AI generator produces is saved
-- here so the operator has history ("what did I say during the May 26 event")
-- and can reload a past script into the console + teleprompter. Previously the
-- script lived only in localStorage (lib/broadcast/script-store.ts), which is
-- still used as the console → teleprompter hand-off; this table is the durable
-- copy.
--
-- Retention: unbounded — scripts are small (a few KB of jsonb) and the list
-- UI pages by created_at. Revisit if this ever matters.

create table if not exists public.broadcast_scripts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null
    references public.operators(user_id) on delete cascade,
  -- Denormalized from the script jsonb for cheap list rendering.
  title text not null,
  summary text,
  mode text not null default 'recorded' check (mode in ('live', 'recorded')),
  target_minutes int not null default 3,
  -- Full BroadcastScript object (segments, YouTube package, thumbnail line).
  script jsonb not null,
  -- Briefing-snapshot timestamp the script was generated from, so the list
  -- can show "data as of" separately from "saved at".
  context_generated_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists broadcast_scripts_created_idx
  on public.broadcast_scripts (created_at desc);

alter table public.broadcast_scripts enable row level security;

-- Mirror every other public.* table: operators see/edit everything, anon and
-- authenticated-non-operator roles see nothing.
create policy "op broadcast_scripts_all"
  on public.broadcast_scripts for all
  using (public.is_operator())
  with check (public.is_operator());
