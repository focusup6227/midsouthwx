-- Subscriber-submitted storm reports, sent through the Telegram bot via the
-- /report flow. Mirrors nws_storm_reports for the radar overlay (same hazard
-- normalization + GeoJSON shape), but the source is a single subscriber, not
-- the NWS LSR feed. Photos land in the storm-report-photos bucket.

create table if not exists public.telegram_storm_reports (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  hazard text not null
    check (hazard in ('tornado','funnel','wind','hail','flood','other')),
  description text,
  photo_url text,
  photo_file_id text,                       -- Telegram's permanent file_id, for re-fetching
  lat double precision not null,
  lon double precision not null,
  point geography(Point, 4326) not null,
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists telegram_storm_reports_point_gix
  on public.telegram_storm_reports using gist (point);
create index if not exists telegram_storm_reports_reported_idx
  on public.telegram_storm_reports (reported_at desc);
create index if not exists telegram_storm_reports_subscriber_idx
  on public.telegram_storm_reports (subscriber_id, reported_at desc);

alter table public.telegram_storm_reports enable row level security;

create policy "op telegram_storm_reports_select"
  on public.telegram_storm_reports for select
  using (public.is_operator());

create policy "op telegram_storm_reports_update"
  on public.telegram_storm_reports for update
  using (public.is_operator())
  with check (public.is_operator());

create policy "op telegram_storm_reports_delete"
  on public.telegram_storm_reports for delete
  using (public.is_operator());

-- Storage bucket for the attached photos. Public-read so the radar map can
-- render the thumbnail without minting signed URLs per pin; service_role writes
-- from the telegram-webhook function (no RLS needed for that path).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'storm-report-photos',
  'storm-report-photos',
  true,
  20971520,                                          -- 20 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create policy "storm-report-photos public read"
  on storage.objects for select
  using (bucket_id = 'storm-report-photos');

create policy "storm-report-photos operator delete"
  on storage.objects for delete
  using (bucket_id = 'storm-report-photos' and public.is_operator());

-- Mirrors nws_storm_reports_geojson — recent subscriber reports inside the
-- mid-south envelope as a FeatureCollection for the /api/radar/storm-reports
-- endpoint.
create or replace function public.telegram_storm_reports_geojson(p_hours integer default 24)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with midsouth as (
    select st_setsrid(st_makeenvelope(-93.5, 32.8, -82.0, 37.5, 4326), 4326)::geography as g
  ),
  recent as (
    select r.id, r.hazard, r.description, r.photo_url, r.lat, r.lon,
           r.reported_at, s.display_name, s.telegram_username
    from public.telegram_storm_reports r
    join public.subscribers s on s.id = r.subscriber_id
    cross join midsouth m
    where r.reported_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
      and st_intersects(r.point, m.g)
    order by r.reported_at desc
    limit 500
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'id', r.id,
          'geometry', jsonb_build_object(
            'type', 'Point',
            'coordinates', jsonb_build_array(r.lon, r.lat)
          ),
          'properties', jsonb_build_object(
            'id', r.id,
            'hazard', r.hazard,
            'description', r.description,
            'photo_url', r.photo_url,
            'reported_at', r.reported_at,
            'reporter', coalesce(r.display_name, r.telegram_username, 'subscriber')
          )
        )
        order by r.reported_at desc
      ),
      '[]'::jsonb
    )
  )
  from recent r;
$$;

revoke all on function public.telegram_storm_reports_geojson(integer) from public, anon;
grant execute on function public.telegram_storm_reports_geojson(integer) to authenticated, service_role;
