-- Optional TTL on /where temporary addresses. A subscriber who forgets to
-- send /home after a trip would otherwise keep getting alerts for whichever
-- city they last set. With a TTL, the cron job below auto-reverts them.

alter table public.subscribers
  add column if not exists current_location_expires_at timestamptz;

create index if not exists subscribers_temp_expiry_idx
  on public.subscribers (current_location_expires_at)
  where current_location_expires_at is not null;

create or replace function public.subscriber_revert_expired_locations()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count int;
begin
  with reverted as (
    update public.subscribers
       set location                    = coalesce(home_location, location),
           current_address             = null,
           current_address_updated_at  = null,
           current_location_expires_at = null,
           updated_at                  = now()
     where current_location_expires_at is not null
       and current_location_expires_at <= now()
    returning id
  )
  select count(*)::int into v_count from reverted;
  return v_count;
end;
$$;

revoke all on function public.subscriber_revert_expired_locations() from public, anon, authenticated;
grant execute on function public.subscriber_revert_expired_locations() to service_role;

-- Every 5 minutes, sweep expired temp locations back to home.
select cron.schedule(
  'subscriber-temp-location-expire',
  '*/5 * * * *',
  $$ select public.subscriber_revert_expired_locations(); $$
);
