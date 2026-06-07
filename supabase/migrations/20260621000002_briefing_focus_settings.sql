-- Make the briefing focus area operator-configurable.
--
-- 20260621000001 clipped the SPC "highest risk" headline to a *hardcoded*
-- Mid-South box. This replaces that constant with a stored center + radius the
-- operator can edit on /settings, so the briefing card and day tiles headline
-- the risk over whatever area they cover. Defaults to Memphis (KNQA), ~200 mi.
--
-- The card (app/cards/outlook/route.ts) reads the same row via the service role
-- and derives its map framing + headline from it, so the graphic and the page
-- always agree.

-- Singleton config row. `id` is a boolean pinned true so there's exactly one.
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  briefing_focus_label text not null default 'Memphis',
  briefing_focus_lat double precision not null default 35.34,
  briefing_focus_lon double precision not null default -89.87,
  briefing_focus_radius_mi double precision not null default 200
    check (briefing_focus_radius_mi between 10 and 1000),
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;

-- Operator-only read/update; service_role bypasses RLS for the card.
drop policy if exists "op app_settings_select" on public.app_settings;
create policy "op app_settings_select"
  on public.app_settings for select
  using (public.is_operator());

drop policy if exists "op app_settings_update" on public.app_settings;
create policy "op app_settings_update"
  on public.app_settings for update
  using (public.is_operator())
  with check (public.is_operator());

-- The focus area as a geometry: a square envelope `radius_mi` on each side of
-- the center, miles converted to degrees (lon scaled by cos(lat)). A box rather
-- than a circle so it matches the rectangular map the card frames.
create or replace function public.briefing_focus_geom()
returns geometry
language sql
stable
security definer
set search_path = public, extensions
as $$
  select st_makeenvelope(
    briefing_focus_lon - (briefing_focus_radius_mi / (69.0 * cos(radians(briefing_focus_lat)))),
    briefing_focus_lat - (briefing_focus_radius_mi / 69.0),
    briefing_focus_lon + (briefing_focus_radius_mi / (69.0 * cos(radians(briefing_focus_lat)))),
    briefing_focus_lat + (briefing_focus_radius_mi / 69.0),
    4326
  )
  from public.app_settings
  where id;
$$;

revoke all on function public.briefing_focus_geom() from public, anon;
grant execute on function public.briefing_focus_geom() to authenticated, service_role;

-- Re-point the AOR-clip helper at the configurable focus geometry (was a
-- hardcoded st_makeenvelope in 20260621000001).
create or replace function public.spc_highest_label_in_aor(p_day_number integer)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select f->'properties'->>'LABEL'
  from public.spc_outlooks o
  cross join lateral jsonb_array_elements(coalesce(o.geojson->'features', '[]'::jsonb)) as f
  where o.day_number = p_day_number
    and coalesce(f->'properties'->>'LABEL', '') <> ''
    and st_intersects(
          st_setsrid(st_geomfromgeojson(f->'geometry'), 4326),
          public.briefing_focus_geom()
        )
  order by public.spc_label_rank(f->'properties'->>'LABEL') desc
  limit 1;
$$;

revoke all on function public.spc_highest_label_in_aor(integer) from public, anon;
grant execute on function public.spc_highest_label_in_aor(integer) to authenticated, service_role;

-- Surface the active focus area in the briefing snapshot so the page can label
-- the SPC tiles ("highest risk within 200 mi of Memphis"). Otherwise identical
-- to 20260621000001's definition.
create or replace function public.daily_briefing_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with spc as (
    select jsonb_object_agg(
      day_number::text,
      jsonb_build_object(
        'highest_label', public.spc_highest_label_in_aor(day_number),
        'issued_at',     issued_at,
        'valid_from',    valid_from,
        'valid_until',   valid_until
      )
    ) as days
    from public.spc_outlooks
    where day_number in (1, 2, 3)
  ),
  latest_afd as (
    select wfo, product_id, issued_at, synopsis, short_term, ai_summary,
           row_number() over (partition by wfo order by issued_at desc) as rn
    from public.nws_afd
    where issued_at >= now() - interval '24 hours'
  ),
  afd_arr as (
    select jsonb_agg(
      jsonb_build_object(
        'wfo',        wfo,
        'product_id', product_id,
        'issued_at',  issued_at,
        'synopsis',   coalesce(ai_summary, synopsis, short_term)
      )
      order by issued_at desc
    ) as arr
    from latest_afd where rn = 1
  ),
  hwos as (
    select jsonb_agg(
      jsonb_build_object(
        'id',        id,
        'event',     event,
        'headline',  headline,
        'area_desc', area_desc,
        'effective', effective,
        'expires_at', expires_at
      )
      order by effective desc
    ) as arr
    from public.nws_alerts
    where status = 'new'
      and event ilike '%hazardous weather%'
      and coalesce(expires_at, now()) >= now()
  ),
  counts as (
    select
      count(*) filter (where event ilike '%warning%') as warnings_count,
      count(*) filter (where event ilike '%watch%')   as watches_count
    from public.nws_alerts
    where status = 'new'
      and coalesce(expires_at, now()) >= now()
  ),
  focus as (
    select jsonb_build_object(
      'label',     briefing_focus_label,
      'lat',       briefing_focus_lat,
      'lon',       briefing_focus_lon,
      'radius_mi', briefing_focus_radius_mi
    ) as obj
    from public.app_settings where id
  )
  select jsonb_build_object(
    'spc',             coalesce((select days from spc), '{}'::jsonb),
    'afds',            coalesce((select arr  from afd_arr), '[]'::jsonb),
    'hwos',            coalesce((select arr  from hwos), '[]'::jsonb),
    'warnings_count',  (select warnings_count from counts),
    'watches_count',   (select watches_count  from counts),
    'focus',           (select obj from focus),
    'generated_at',    now()
  );
$$;

revoke all on function public.daily_briefing_snapshot() from public, anon;
grant execute on function public.daily_briefing_snapshot() to authenticated, service_role;
