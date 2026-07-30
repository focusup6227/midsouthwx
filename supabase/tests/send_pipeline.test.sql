-- pgTAP tests for the send pipeline's load-bearing SQL.
--
-- The core product guarantee is preview-count == queued-count == the exact
-- set of people a life-safety alert reaches. These tests pin the observable
-- behavior of resolve_audience + enqueue_message_system so a migration that
-- accidentally widens/narrows an audience fails CI instead of firing at 2 AM.
--
-- Run locally:  supabase db reset && supabase test db
-- Runs inside a transaction and rolls back — no fixture residue.

begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

-- ── Fixtures ──────────────────────────────────────────────────────────────
-- Memphis-ish coordinates. sub1 active w/ location, sub2 paused, sub3 active
-- without any location, sub4 unsubscribed, sub5 active far away (Nashville).
insert into public.subscribers (id, display_name, status, telegram_chat_id, location) values
  ('a0000000-0000-0000-0000-000000000001', 'Active Memphis',  'active',       101, extensions.st_setsrid(extensions.st_makepoint(-90.05, 35.15), 4326)::geography),
  ('a0000000-0000-0000-0000-000000000002', 'Paused Memphis',  'paused',       102, extensions.st_setsrid(extensions.st_makepoint(-90.06, 35.14), 4326)::geography),
  ('a0000000-0000-0000-0000-000000000003', 'Active NoLoc',    'active',       103, null),
  ('a0000000-0000-0000-0000-000000000004', 'Unsubscribed',    'unsubscribed', 104, extensions.st_setsrid(extensions.st_makepoint(-90.05, 35.15), 4326)::geography),
  ('a0000000-0000-0000-0000-000000000005', 'Active Nashville','active',       105, extensions.st_setsrid(extensions.st_makepoint(-86.78, 36.16), 4326)::geography);

insert into public.custom_groups (id, name) values
  ('b0000000-0000-0000-0000-000000000001', 'test group');
insert into public.group_memberships (group_id, subscriber_id) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002'); -- paused: must be excluded

-- ── resolve_audience ──────────────────────────────────────────────────────

select is(
  (select count(*) from public.resolve_audience('{"all": true}'::jsonb))::int,
  3,
  'all: exactly the three active subscribers'
);

select is(
  (select count(*) from public.resolve_audience('{}'::jsonb))::int,
  0,
  'empty spec resolves to nobody (no accidental broadcast)'
);

select is(
  (select count(*) from public.resolve_audience(
    '{"subscribers": ["a0000000-0000-0000-0000-000000000001", "a0000000-0000-0000-0000-000000000004"]}'::jsonb))::int,
  1,
  'explicit list drops non-active subscribers'
);

select is(
  (select count(*) from public.resolve_audience(
    '{"groups": ["b0000000-0000-0000-0000-000000000001"]}'::jsonb))::int,
  1,
  'group audience: members only, paused member excluded'
);

-- Circle: 10 km around Memphis catches sub1 only (sub2 paused, sub4 unsub,
-- sub3 has no location, sub5 is ~300 km away).
select is(
  (select count(*) from public.resolve_audience(
    '{"geometry": {"type": "circle", "center": [-90.05, 35.15], "radius_km": 10}}'::jsonb))::int,
  1,
  'geometry circle: active-with-location inside radius only'
);

select is(
  (select subscriber_id from public.resolve_audience(
    '{"geometry": {"type": "circle", "center": [-90.05, 35.15], "radius_km": 10}}'::jsonb)),
  'a0000000-0000-0000-0000-000000000001'::uuid,
  'geometry circle: the one hit is the Memphis subscriber'
);

select is(
  (select count(*) from public.resolve_audience(
    '{"geometry": {"type": "circle", "center": [-90.05, 35.15], "radius_km": 500}}'::jsonb))::int,
  2,
  'geometry circle wide: Memphis + Nashville, never the paused/unsubscribed/no-location rows'
);

select is(
  (select count(*) from public.resolve_audience(
    '{"geometry": {"type": "Polygon", "coordinates": [[[-90.2, 35.0], [-89.9, 35.0], [-89.9, 35.3], [-90.2, 35.3], [-90.2, 35.0]]]}}'::jsonb))::int,
  1,
  'geometry polygon: Memphis box catches only the active Memphis subscriber'
);

-- ── enqueue_message_system: the preview == queued invariant ───────────────

insert into public.messages (id, body_md, source, status, audience_spec) values
  ('c0000000-0000-0000-0000-000000000001', 'test broadcast', 'manual', 'draft', '{"all": true}'::jsonb);

select is(
  public.enqueue_message_system('c0000000-0000-0000-0000-000000000001'),
  3,
  'enqueue returns the same count resolve_audience previews'
);

select is(
  (select count(*) from public.outbound_queue where message_id = 'c0000000-0000-0000-0000-000000000001')::int,
  3,
  'queue rows match the resolved audience'
);

select is(
  (select status::text from public.messages where id = 'c0000000-0000-0000-0000-000000000001'),
  'queued',
  'message flips to queued'
);

select is(
  (select recipient_count from public.messages where id = 'c0000000-0000-0000-0000-000000000001'),
  3,
  'recipient_count recorded'
);

select is(
  public.enqueue_message_system('c0000000-0000-0000-0000-000000000001'),
  3,
  're-enqueue is idempotent — dedup index prevents double sends'
);

-- ── NWS preference gating ─────────────────────────────────────────────────
-- sub1 opts out of warnings; sub3/sub5 keep defaults (default = wants).
update public.subscribers
  set alert_preferences = alert_preferences || '{"warnings": false}'::jsonb
  where id = 'a0000000-0000-0000-0000-000000000001';

insert into public.nws_alerts (id, nws_id, event, status, raw) values
  ('d0000000-0000-0000-0000-000000000001', 'urn:test:tor-1', 'Tornado Warning', 'new', '{}'::jsonb);

insert into public.messages (id, body_md, source, status, audience_spec, nws_alert_id) values
  ('c0000000-0000-0000-0000-000000000002', 'tor warning', 'nws', 'draft', '{"all": true}'::jsonb,
   'd0000000-0000-0000-0000-000000000001');

select is(
  public.enqueue_message_system('c0000000-0000-0000-0000-000000000002'),
  2,
  'nws enqueue respects an explicit warnings opt-out'
);

select ok(
  not exists (
    select 1 from public.outbound_queue
    where message_id = 'c0000000-0000-0000-0000-000000000002'
      and subscriber_id = 'a0000000-0000-0000-0000-000000000001'
  ),
  'the opted-out subscriber is the one excluded'
);

-- Non-NWS sources ignore event preferences entirely.
insert into public.messages (id, body_md, source, status, audience_spec) values
  ('c0000000-0000-0000-0000-000000000003', 'manual to all', 'manual', 'draft', '{"all": true}'::jsonb);

select is(
  public.enqueue_message_system('c0000000-0000-0000-0000-000000000003'),
  3,
  'manual sends ignore NWS category preferences'
);

select * from finish();
rollback;
