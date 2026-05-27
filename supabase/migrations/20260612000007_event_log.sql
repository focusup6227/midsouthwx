-- F14: operator event log. Running timestamped log of operator notes,
-- decisions, and observations during a severe weather episode. Filter by
-- tag/date and export to CSV/Markdown for post-event verification or a
-- social-media write-up.
--
-- v1 schema is intentionally flat — no explicit "event" entity. Tags are
-- the grouping mechanism: an operator types `outbreak2026-04-15` as a tag
-- and every note tagged the same way exports together. If we later need
-- a real Event table (with start/end, lead/lag windows, etc.) we can
-- backfill from tag rollups.

create type public.event_log_severity as enum ('info', 'warning', 'critical');

create table if not exists public.event_log_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  occurred_at timestamptz not null default now(),
  -- created_by = author. defaults to the current auth user; service role
  -- writes (auto-ingested decisions / system notes) set this explicitly.
  created_by uuid references auth.users(id) on delete set null,
  body text not null,
  tags text[] not null default '{}',
  severity public.event_log_severity not null default 'info',
  -- Optional geographic anchor — when an operator notes "tornado on the
  -- ground 2 NE of Bartlett" they can attach the LSR's lat/lon so the
  -- export can map-render the timeline.
  point geography(Point, 4326),
  -- Optional reference links (NWS warning id, /compose message id,
  -- snapshot URL, etc.) so the export can link back to source artifacts.
  refs jsonb not null default '{}'::jsonb
);

create index if not exists event_log_entries_occurred_idx
  on public.event_log_entries (occurred_at desc);
create index if not exists event_log_entries_tags_gix
  on public.event_log_entries using gin (tags);
create index if not exists event_log_entries_point_gix
  on public.event_log_entries using gist (point)
  where point is not null;

alter table public.event_log_entries enable row level security;

create policy "op event_log_select" on public.event_log_entries
  for select using (public.is_operator());
create policy "op event_log_insert" on public.event_log_entries
  for insert with check (public.is_operator());
create policy "op event_log_update" on public.event_log_entries
  for update using (public.is_operator()) with check (public.is_operator());
create policy "op event_log_delete" on public.event_log_entries
  for delete using (public.is_operator());
