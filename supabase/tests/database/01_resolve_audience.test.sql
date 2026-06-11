-- pgTAP: public.resolve_audience(spec) + the preview-count = queued-count
-- guarantee (enqueue_message_system / enqueue_message route through the same
-- function — see CLAUDE.md "Audience resolution").
--
-- Geography: Memphis (-90.05, 35.15) and Nashville (-86.78, 36.16) are
-- ~320 km apart, so a 50 km circle/corridor separates them and a 400 km one
-- captures both.
begin;
select plan(18);

-- Fixtures --------------------------------------------------------------
insert into public.subscribers (id, display_name, status, telegram_chat_id, location) values
  ('00000000-0000-0000-0000-000000000001', 'Memphis',   'active', 101, st_setsrid(st_makepoint(-90.05, 35.15), 4326)::geography),
  ('00000000-0000-0000-0000-000000000002', 'Nashville', 'active', 102, st_setsrid(st_makepoint(-86.78, 36.16), 4326)::geography),
  ('00000000-0000-0000-0000-000000000003', 'Paused',    'paused', 103, st_setsrid(st_makepoint(-90.05, 35.15), 4326)::geography),
  ('00000000-0000-0000-0000-000000000004', 'NoLoc',     'active', 104, null);

insert into public.regions (id, name, kind) values
  ('00000000-0000-0000-0000-000000000011', 'Shelby Co', 'county');
insert into public.subscriber_regions (subscriber_id, region_id) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011');

insert into public.custom_groups (id, name) values
  ('00000000-0000-0000-0000-000000000021', 'Spotters');
insert into public.group_memberships (group_id, subscriber_id) values
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000002');

-- resolve_audience ------------------------------------------------------
select set_eq(
  $$ select subscriber_id from public.resolve_audience('{"all": true}') $$,
  array['00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000004']::uuid[],
  'all:true returns every active subscriber (paused/pending excluded), with or without location'
);

select is(
  (select count(*) from public.resolve_audience('{}')), 0::bigint,
  'empty spec resolves to nobody'
);

select set_eq(
  $$ select subscriber_id from public.resolve_audience(
       '{"subscribers": ["00000000-0000-0000-0000-000000000001",
                         "00000000-0000-0000-0000-000000000003"]}') $$,
  array['00000000-0000-0000-0000-000000000001']::uuid[],
  'explicit list returns only active members — a paused subscriber is excluded even when named'
);

select set_eq(
  $$ select subscriber_id from public.resolve_audience(
       '{"regions": ["00000000-0000-0000-0000-000000000011"]}') $$,
  array['00000000-0000-0000-0000-000000000001']::uuid[],
  'region spec resolves via subscriber_regions'
);

select set_eq(
  $$ select subscriber_id from public.resolve_audience(
       '{"groups": ["00000000-0000-0000-0000-000000000021"]}') $$,
  array['00000000-0000-0000-0000-000000000002']::uuid[],
  'group spec resolves via group_memberships'
);

select set_eq(
  $$ select subscriber_id from public.resolve_audience(
       '{"geometry": {"type": "circle", "center": [-90.05, 35.15], "radius_km": 50}}') $$,
  array['00000000-0000-0000-0000-000000000001']::uuid[],
  '50 km circle around Memphis catches Memphis only'
);

select set_eq(
  $$ select subscriber_id from public.resolve_audience(
       '{"geometry": {"type": "circle", "center": [-90.05, 35.15], "radius_km": 400}}') $$,
  array['00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002']::uuid[],
  '400 km circle catches both located subscribers; no-location subscriber never matches geometry'
);

select set_eq(
  $$ select subscriber_id from public.resolve_audience(
       '{"geometry": {"type": "Polygon",
          "coordinates": [[[-90.5,34.8],[-89.5,34.8],[-89.5,35.5],[-90.5,35.5],[-90.5,34.8]]]}}') $$,
  array['00000000-0000-0000-0000-000000000001']::uuid[],
  'GeoJSON polygon over Memphis catches Memphis only'
);

select set_eq(
  $$ select subscriber_id from public.resolve_audience(
       '{"geometry": {"type": "track",
          "line": {"type": "LineString", "coordinates": [[-90.05,35.15],[-88.8,35.6]]},
          "corridor_km": 30}}') $$,
  array['00000000-0000-0000-0000-000000000001']::uuid[],
  '30 km track corridor from Memphis toward Jackson catches Memphis only'
);

select set_eq(
  $$ select subscriber_id from public.resolve_audience(
       '{"geometry": {"type": "track",
          "line": {"type": "LineString", "coordinates": [[-90.05,35.15],[-88.8,35.6]]},
          "corridor_km": 300}}') $$,
  array['00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002']::uuid[],
  '300 km corridor catches both located subscribers'
);

select is(
  (select count(*) from public.resolve_audience(
     '{"subscribers": ["00000000-0000-0000-0000-000000000001"],
       "regions": ["00000000-0000-0000-0000-000000000011"]}')),
  1::bigint,
  'a subscriber matched by multiple branches is returned once (distinct)'
);

-- preview-count = queued-count -------------------------------------------
insert into public.messages (id, body_md, source, audience_spec) values
  ('00000000-0000-0000-0000-000000000031', 'hello', 'manual', '{"all": true}');

select is(
  public.enqueue_message_system('00000000-0000-0000-0000-000000000031'),
  (select count(*)::int from public.resolve_audience('{"all": true}')),
  'enqueue_message_system queues exactly the resolve_audience preview count'
);

select is(
  (select count(*) from public.outbound_queue
    where message_id = '00000000-0000-0000-0000-000000000031'),
  3::bigint,
  'one outbound_queue row per resolved subscriber'
);

select is(
  public.enqueue_message_system('00000000-0000-0000-0000-000000000031'),
  3,
  're-enqueue is idempotent (unique (message_id, subscriber_id) + on conflict do nothing)'
);

select results_eq(
  $$ select status::text, recipient_count from public.messages
      where id = '00000000-0000-0000-0000-000000000031' $$,
  $$ values ('queued', 3) $$,
  'message flips to queued with the recipient count'
);

-- NWS preference gate ------------------------------------------------------
insert into public.nws_alerts (id, nws_id, event) values
  ('00000000-0000-0000-0000-000000000041', 'urn:test:tor1', 'Tornado Warning');

update public.subscribers
   set alert_preferences = jsonb_build_object(public.nws_event_category('Tornado Warning'), false)
 where id = '00000000-0000-0000-0000-000000000002';

insert into public.messages (id, body_md, source, audience_spec, nws_alert_id) values
  ('00000000-0000-0000-0000-000000000032', 'tornado!', 'nws', '{"all": true}',
   '00000000-0000-0000-0000-000000000041');

select is(
  public.enqueue_message_system('00000000-0000-0000-0000-000000000032'),
  2,
  'nws enqueue drops subscribers who muted the event category'
);

update public.subscribers
   set alert_preferences = '{"skip_hazards": ["tornado"]}'::jsonb
 where id = '00000000-0000-0000-0000-000000000004';

insert into public.messages (id, body_md, source, audience_spec, nws_alert_id) values
  ('00000000-0000-0000-0000-000000000033', 'tornado again', 'nws', '{"all": true}',
   '00000000-0000-0000-0000-000000000041');

select is(
  public.enqueue_message_system('00000000-0000-0000-0000-000000000033'),
  1,
  'nws enqueue also drops subscribers whose skip_hazards covers the event hazard'
);

select set_eq(
  $$ select subscriber_id from public.outbound_queue
      where message_id = '00000000-0000-0000-0000-000000000033' $$,
  array['00000000-0000-0000-0000-000000000001']::uuid[],
  'only the unmuted subscriber is queued for the tornado warning'
);

select * from finish();
rollback;
