-- Smart-gate for couplet-poll: only scan NEXRAD volumes when there's an
-- active convective threat (SPC watch or NWS tornado/severe-thunderstorm
-- warning) intersecting the Mid-South bbox.
--
-- Why: couplet-poll fires every minute and fans out 8 concurrent
-- /couplets/scan requests to the Fly renderer. Outside active convective
-- weather (95%+ of the year for this area) that load was OOM-killing the
-- renderer for zero analytical value — there are no couplets to detect.
--
-- The Mid-South bbox here mirrors MIDSOUTH_BBOX in app/api/radar/mping/route.ts;
-- if either is widened, widen the other.
create or replace function public.couplet_poll_should_run()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.nws_alerts a
    where a.event in (
        'Tornado Watch',
        'Severe Thunderstorm Watch',
        'Tornado Warning',
        'Severe Thunderstorm Warning'
      )
      and a.status in ('new', 'dispatched')
      and (a.effective is null or a.effective <= now())
      and (a.expires_at is null or a.expires_at > now())
      and a.polygon is not null
      and st_intersects(
        a.polygon,
        st_makeenvelope(-93.5, 32.8, -82.0, 37.5, 4326)::geography
      )
  );
$$;

revoke all on function public.couplet_poll_should_run() from public, anon, authenticated;
grant execute on function public.couplet_poll_should_run() to service_role;
