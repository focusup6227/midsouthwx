-- Extend checkin_recipients to also return each subscriber's lon/lat so the
-- /alerts/[id] page can render a real-time map of who's safe / distress /
-- silent. Same ordering and same status semantics as before — just two extra
-- columns. Falls back to home_location when current location is unset.

drop function if exists public.checkin_recipients(uuid);

create function public.checkin_recipients(p_message_id uuid)
returns table(
  subscriber_id     uuid,
  display_name      text,
  telegram_username text,
  current_address   text,
  home_address      text,
  sent_at           timestamptz,
  response_code     text,
  responded_at      timestamptz,
  lon               double precision,
  lat               double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    s.id          as subscriber_id,
    s.display_name,
    s.telegram_username,
    s.current_address,
    s.home_address,
    oq.sent_at,
    cr.response_code,
    cr.responded_at,
    st_x((coalesce(s.location, s.home_location))::geometry) as lon,
    st_y((coalesce(s.location, s.home_location))::geometry) as lat
  from public.outbound_queue oq
  join public.subscribers s on s.id = oq.subscriber_id
  left join public.check_in_responses cr
    on cr.message_id = oq.message_id and cr.subscriber_id = oq.subscriber_id
  where oq.message_id = p_message_id
    and oq.status in ('sent', 'pending')
  order by
    -- Distress first, then unreached, then safe — fastest-to-act-on at top.
    case when cr.response_code in ('help', 'sos') then 0
         when cr.response_code is null then 1
         when cr.response_code = 'safe' then 2
         else 3 end,
    s.display_name;
$$;

revoke all on function public.checkin_recipients(uuid) from public, anon;
grant execute on function public.checkin_recipients(uuid) to authenticated, service_role;
