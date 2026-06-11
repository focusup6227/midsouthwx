-- pgTAP: public.claim_outbound_batch — the send worker's claim RPC.
-- Covers claim/lock semantics, send_after gating, joined payload fields,
-- home_stale computation, and recovery of rows stranded in 'sending' by a
-- dead worker (20260622000001_claim_stale_sending_recovery.sql).
begin;
select plan(13);

-- Fixtures --------------------------------------------------------------
insert into public.subscribers
  (id, display_name, status, telegram_chat_id, location, home_location, home_location_updated_at) values
  ('00000000-0000-0000-0000-000000000001', 'Fresh', 'active', 201,
   st_setsrid(st_makepoint(-90.05, 35.15), 4326)::geography,
   st_setsrid(st_makepoint(-90.05, 35.15), 4326)::geography,
   now()),
  ('00000000-0000-0000-0000-000000000002', 'Stale', 'active', 202,
   null,
   st_setsrid(st_makepoint(-86.78, 36.16), 4326)::geography,
   now() - interval '72 hours');

insert into public.nws_alerts (id, nws_id, event) values
  ('00000000-0000-0000-0000-000000000041', 'urn:test:svr1', 'Severe Thunderstorm Warning');

insert into public.messages (id, body_md, body_rendered, source, audience_spec, nws_alert_id) values
  ('00000000-0000-0000-0000-000000000031', 'raw **md**', '<b>rendered</b>', 'nws', '{"all": true}',
   '00000000-0000-0000-0000-000000000041');
insert into public.messages (id, body_md, source, audience_spec) values
  ('00000000-0000-0000-0000-000000000032', 'plain body', 'manual', '{"all": true}');

insert into public.outbound_queue (id, message_id, subscriber_id, send_after) values
  (1, '00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000001', now() - interval '2 minutes'),
  (2, '00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000002', now() - interval '1 minute'),
  (3, '00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000001', now() + interval '1 hour');

-- Claim semantics ---------------------------------------------------------
select results_eq(
  $$ select id, body_rendered, telegram_chat_id, message_source::text, nws_event
       from public.claim_outbound_batch(1, 'w1', 60) $$,
  $$ values (1::bigint, '<b>rendered</b>', 201::bigint, 'nws', 'Severe Thunderstorm Warning') $$,
  'claims the most-overdue row first (limit honored) with rendered body + joined nws_event'
);

select results_eq(
  $$ select status::text, locked_by from public.outbound_queue where id = 1 $$,
  $$ values ('sending', 'w1') $$,
  'claimed row flips to sending with the claimant recorded'
);

select results_eq(
  $$ select id, home_stale, live_sharing,
            round(subscriber_lon::numeric, 2), round(subscriber_lat::numeric, 2)
       from public.claim_outbound_batch(10, 'w2', 60) $$,
  $$ values (2::bigint, true, false, -86.78::numeric, 36.16::numeric) $$,
  'second worker gets only the unclaimed due row; 72h-old home pin → home_stale, lon/lat falls back to home_location'
);

select is(
  (select count(*) from public.claim_outbound_batch(10, 'w3', 60)),
  0::bigint,
  'future send_after rows are not claimable'
);

update public.outbound_queue set send_after = now() - interval '1 second' where id = 3;

select results_eq(
  $$ select body_rendered, telegram_chat_id, message_source::text, nws_event, home_stale
       from public.claim_outbound_batch(10, 'w4', 60) $$,
  $$ values ('plain body', 201::bigint, 'manual', null::text, false) $$,
  'body_rendered falls back to body_md; manual messages carry null nws_event; fresh home pin is not stale'
);

-- Lock TTL / stale-claim recovery -----------------------------------------
-- w1 "dies": its row stays 'sending'. Within the TTL nobody may steal it.
select is(
  (select count(*) from public.claim_outbound_batch(10, 'w5', 60)),
  0::bigint,
  'a sending row inside its lock TTL is not reclaimable'
);

-- After the TTL lapses the row must be recoverable — otherwise a worker
-- crash silently drops the alert for those subscribers.
update public.outbound_queue
   set locked_at = now() - interval '5 minutes'
 where id = 1;

select results_eq(
  $$ select id, attempts from public.claim_outbound_batch(10, 'w6', 60) $$,
  $$ values (1::bigint, 1) $$,
  'a sending row whose lock TTL lapsed is reclaimed, with the takeover counted as an attempt'
);

select results_eq(
  $$ select status::text, locked_by from public.outbound_queue where id = 1 $$,
  $$ values ('sending', 'w6') $$,
  'recovered row is re-locked by the new claimant'
);

-- Reset-to-pending path (what the worker does on a transient send failure).
update public.outbound_queue
   set status = 'pending', locked_at = null, locked_by = null,
       send_after = now() - interval '1 second'
 where id = 2;

select results_eq(
  $$ select id, attempts from public.claim_outbound_batch(10, 'w7', 60) $$,
  $$ values (2::bigint, 0) $$,
  'a row reset to pending is claimable again without an attempt bump'
);

-- Terminal states are never claimable, even with stale locks.
update public.outbound_queue set status = 'sent',    locked_at = now() - interval '1 hour' where id = 1;
update public.outbound_queue set status = 'failed',  locked_at = now() - interval '1 hour' where id = 2;
update public.outbound_queue set status = 'skipped', locked_at = now() - interval '1 hour' where id = 3;

select is(
  (select count(*) from public.claim_outbound_batch(10, 'w8', 60)),
  0::bigint,
  'sent/failed/skipped rows are never claimable, even with stale locks'
);

-- Fan-out dedupe + exactly-once claim --------------------------------------
insert into public.messages (id, body_md, source, audience_spec) values
  ('00000000-0000-0000-0000-000000000033', 'dedupe me', 'manual', '{"all": true}');

insert into public.outbound_queue (message_id, subscriber_id, send_after)
select '00000000-0000-0000-0000-000000000033',
       '00000000-0000-0000-0000-000000000002', now() - interval '1 minute'
from generate_series(1, 5)
on conflict (message_id, subscriber_id) do nothing;

select is(
  (select count(*) from public.outbound_queue
    where message_id = '00000000-0000-0000-0000-000000000033'),
  1::bigint,
  'unique (message_id, subscriber_id) caps fan-out at one row per recipient'
);

select is(
  (select count(*) from public.claim_outbound_batch(10, 'w9', 60)),
  1::bigint,
  'the deduped row is claimable exactly once'
);

select is(
  (select count(*) from public.claim_outbound_batch(10, 'w10', 60)),
  0::bigint,
  'and nothing remains claimable after it is claimed'
);

select * from finish();
rollback;
