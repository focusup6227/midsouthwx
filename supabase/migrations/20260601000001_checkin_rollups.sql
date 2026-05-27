-- F5 (safety check-ins): aggregate the last N hours of check-in messages
-- into one row per message with safe / distress / other / unreached counts.
-- The "/checkins" dashboard renders this directly; CheckinTally.tsx
-- continues to serve the per-message detail view on /alerts/[id].
--
-- Response code conventions (set by /compose's safety check-in toggle):
--   'safe'  → tapped "I'm safe"
--   'help'  → tapped "Need help" (also flips replies.is_distress in webhook)
--   <other> → custom callback_data (rare; only with hand-edited quick_replies)
--
-- Unreached = subscribers we successfully sent to who haven't tapped any
-- button. Uses outbound_queue.status = 'sent' as the "received" signal —
-- the outbound_status enum has no 'delivered' value (Telegram doesn't give
-- bots read receipts), and our send-worker only writes 'sent' on a 200
-- from sendMessage.

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
    where m.source = 'checkin'
      and m.created_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
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
           count(*) filter (where cr.response_code = 'safe')::int as safe_n,
           count(*) filter (where cr.response_code = 'help')::int as distress_n,
           count(*) filter (where cr.response_code is not null
                              and cr.response_code not in ('safe', 'help'))::int as other_n,
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

revoke all on function public.checkin_rollups(integer) from public, anon;
grant execute on function public.checkin_rollups(integer) to authenticated, service_role;
