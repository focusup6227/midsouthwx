-- Keep the subscriber's home coordinates around so the /where ↔ /home swap
-- in the Telegram bot can revert the map pin without re-geocoding. Existing
-- subscribers backfill from `location` because the /where path used to leave
-- `location` untouched — for everyone today, current location IS home.

alter table public.subscribers
  add column if not exists home_location geography(Point, 4326);

update public.subscribers
   set home_location = location
 where home_location is null
   and location is not null;

create index if not exists subscribers_home_location_gix
  on public.subscribers using gist (home_location);
