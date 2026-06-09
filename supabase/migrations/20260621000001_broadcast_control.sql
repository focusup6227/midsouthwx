-- Live broadcast overlay control: a single-row table the broadcast console
-- writes (operator-only) and the OBS overlays read (in ?live=1 mode, via the
-- public /api/broadcast/state endpoint which queries with the service role).
-- Lets the operator change the lower-third text and toggle overlay visibility
-- on air without editing OBS browser-source URLs. Public NWS-data convention is
-- unaffected — this row holds only operator-authored on-screen text/flags.

create table if not exists public.broadcast_control (
  -- Singleton: one row, always id=true. The check + PK guarantee a single row.
  id boolean primary key default true,
  brand                text    not null default 'MID-SOUTH WX',
  accent               text    not null default '#fbbf24',
  lower_third_title    text    not null default '',
  lower_third_subtitle text    not null default 'Severe Weather Briefing',
  lower_third_visible  boolean not null default false,
  bug_visible          boolean not null default true,
  ticker_visible       boolean not null default true,
  updated_at           timestamptz not null default now(),
  constraint broadcast_control_singleton check (id = true)
);

insert into public.broadcast_control (id) values (true) on conflict (id) do nothing;

alter table public.broadcast_control enable row level security;

-- Operator-only, mirroring the uniform is_operator() pattern. The overlay read
-- path uses the service role (bypasses RLS) like the other /cards + /api
-- broadcast public surfaces.
create policy "op broadcast_control_all" on public.broadcast_control
  for all using (public.is_operator()) with check (public.is_operator());
