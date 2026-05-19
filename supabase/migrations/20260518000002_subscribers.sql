-- 0002 — subscribers, regions, automatic region matching

create type subscriber_status as enum ('pending', 'active', 'paused', 'unsubscribed');

create table public.subscribers (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint unique,
  telegram_username text,
  display_name text not null,
  phone text,
  email text,
  location geography(Point, 4326),
  zip text,
  county_fips text,
  status subscriber_status not null default 'pending',
  link_token text unique,
  link_expires_at timestamptz,
  unsubscribe_token text unique default encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index subscribers_location_gix on public.subscribers using gist (location);
create index subscribers_county on public.subscribers (county_fips);
create index subscribers_status on public.subscribers (status);

create table public.regions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('county', 'zone', 'custom_polygon')),
  county_fips text,
  ugc_code text,
  geometry geography(MultiPolygon, 4326),
  created_at timestamptz default now()
);
create index regions_geometry_gix on public.regions using gist (geometry);
create unique index regions_county_uniq on public.regions(county_fips) where county_fips is not null;
create unique index regions_ugc_uniq on public.regions(ugc_code) where ugc_code is not null;

create table public.subscriber_regions (
  subscriber_id uuid references public.subscribers(id) on delete cascade,
  region_id uuid references public.regions(id) on delete cascade,
  primary key (subscriber_id, region_id)
);
create index subscriber_regions_region_idx on public.subscriber_regions(region_id);

create or replace function private.refresh_subscriber_regions(p_sub uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.subscriber_regions where subscriber_id = p_sub;
  insert into public.subscriber_regions (subscriber_id, region_id)
  select p_sub, r.id
  from public.regions r, public.subscribers s
  where s.id = p_sub
    and (
      (s.location is not null and r.geometry is not null and st_intersects(s.location, r.geometry))
      or (s.county_fips is not null and r.county_fips = s.county_fips)
    );
end$$;

create or replace function private.sub_regions_trigger() returns trigger
language plpgsql as $$
begin
  perform private.refresh_subscriber_regions(new.id);
  return new;
end$$;

create trigger sub_regions_after_change
after insert or update of location, county_fips on public.subscribers
for each row execute function private.sub_regions_trigger();

-- Region edits must re-match every subscriber.
create or replace function private.rebuild_region_memberships(p_region uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.subscriber_regions where region_id = p_region;
  insert into public.subscriber_regions (subscriber_id, region_id)
  select s.id, r.id
  from public.subscribers s, public.regions r
  where r.id = p_region
    and (
      (s.location is not null and r.geometry is not null and st_intersects(s.location, r.geometry))
      or (s.county_fips is not null and r.county_fips = s.county_fips)
    );
end$$;

create or replace function private.regions_trigger() returns trigger
language plpgsql as $$
begin
  perform private.rebuild_region_memberships(new.id);
  return new;
end$$;

create trigger regions_after_change
after insert or update of geometry, county_fips on public.regions
for each row execute function private.regions_trigger();

alter table public.subscribers enable row level security;
alter table public.regions enable row level security;
alter table public.subscriber_regions enable row level security;

create policy "op subs" on public.subscribers
  for all using (public.is_operator()) with check (public.is_operator());
create policy "op regions" on public.regions
  for all using (public.is_operator()) with check (public.is_operator());
create policy "op sub regions" on public.subscriber_regions
  for all using (public.is_operator()) with check (public.is_operator());

-- Public signup never touches the Data API directly — the signup Edge Function
-- runs as service_role and writes here. anon/authenticated have no grants.
