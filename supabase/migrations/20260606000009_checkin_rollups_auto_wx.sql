-- Extend checkin_rollups so the dashboard /checkins view also surfaces the
-- AUTO check-ins attached to tornado/severe/flood warnings by the send
-- worker (Phase #35). Those messages have source='nws' (not 'checkin') and
-- no operator-set quick_replies; the safety buttons are synthesized at send
-- time. Mirror the worker's pickQuickReplies() condition here so the rollup
-- includes them.

create or replace function public.checkin_rollups(p_hours integer default 24)
returns table(
  message_id uuid,
  created_at timestamptz,
  sent_at timestamptz,
  body_md text,
  status text,
  recipient_count integer,
  delivered_count integer,
  safe_count integer,
  distress_count integer,
  other_count integer,
  responded_count integer,
  unreached_count integer
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with recent as (
    select m.id,
           m.created_at,
           m.sent_at,
           m.body_md,
           m.status::text as status,
           coalesce(m.recipient_count, 0) as recipient_count
    from public.messages m
    left join public.nws_alerts a on a.id = m.nws_alert_id
    where m.created_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
      and (
        m.source = 'checkin'
        or (
          m.source = 'nws'
          and a.event ilike '%warning%'
          and (
            a.event ilike '%tornado%'
            or a.event ilike '%severe%'
            or a.event ilike '%flood%'
          )
        )
      )
  ),
  delivered as (
    select oq.message_id, count(*)::int as n
    from public.outbound_queue oq
    where oq.message_id in (select id from recent)
      and oq.status = 'sent'
    group by oq.message_id
  ),
  responses as (
    select cr.message_id,
           count(*) filter (where cr.response_code in ('safe'))::int as safe_n,
           count(*) filter (where cr.response_code in ('help', 'sos'))::int as distress_n,
           count(*) filter (where cr.response_code is not null
                              and cr.response_code not in ('safe', 'help', 'sos'))::int as other_n,
           count(*)::int as total_n
    from public.check_in_responses cr
    where cr.message_id in (select id from recent)
    group by cr.message_id
  )
  select
    r.id as message_id,
    r.created_at,
    r.sent_at,
    r.body_md,
    r.status,
    r.recipient_count,
    coalesce(d.n, 0) as delivered_count,
    coalesce(resp.safe_n, 0) as safe_count,
    coalesce(resp.distress_n, 0) as distress_count,
    coalesce(resp.other_n, 0) as other_count,
    coalesce(resp.total_n, 0) as responded_count,
    greatest(coalesce(d.n, r.recipient_count) - coalesce(resp.total_n, 0), 0) as unreached_count
  from recent r
  left join delivered d on d.message_id = r.id
  left join responses resp on resp.message_id = r.id
  order by r.created_at desc;
$$;

-- Per-message subscriber breakdown for the drill-in. Returns one row per
-- subscriber who was sent the message, with their response code if any.
-- Operators use this to see who hasn't checked in yet on an active warning.
create or replace function public.checkin_recipients(p_message_id uuid)
returns table(
  subscriber_id     uuid,
  display_name      text,
  telegram_username text,
  current_address   text,
  home_address      text,
  sent_at           timestamptz,
  response_code     text,
  responded_at      timestamptz
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
    cr.responded_at
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
