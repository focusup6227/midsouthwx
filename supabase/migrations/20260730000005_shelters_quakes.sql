-- Support for two external-data features:
--   A. FEMA open shelters in distress replies — telegram-webhook needs a
--      subscriber's coordinates to find the nearest open shelter.
--   B. USGS earthquake watch (New Madrid) — dedup table + cron for the
--      earthquake-poll edge function.

-- A. Single-subscriber coordinates (service-role only; webhook use).
create or replace function public.subscriber_latlon(p_id uuid)
returns table (lat double precision, lon double precision)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    st_y(coalesce(s.location, s.home_location)::geometry),
    st_x(coalesce(s.location, s.home_location)::geometry)
  from public.subscribers s
  where s.id = p_id
    and coalesce(s.location, s.home_location) is not null;
$$;

revoke all on function public.subscriber_latlon(uuid) from public, anon, authenticated;
grant execute on function public.subscriber_latlon(uuid) to service_role;

-- B. Earthquake dedup + audit.
create table if not exists public.earthquake_events (
  usgs_id text primary key,
  magnitude real not null,
  place text,
  occurred_at timestamptz not null,
  lat double precision not null,
  lon double precision not null,
  notified_at timestamptz not null default now()
);

alter table public.earthquake_events enable row level security;
create policy "op earthquake_events_select"
  on public.earthquake_events for select
  using (public.is_operator());

select cron.schedule(
  'earthquake-poll',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/earthquake-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'earthquake-events-prune',
  '45 3 * * *',
  $$ delete from public.earthquake_events where occurred_at < now() - interval '180 days'; $$
);
