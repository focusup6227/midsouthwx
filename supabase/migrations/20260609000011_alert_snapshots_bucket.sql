-- Storage bucket for nws-dispatcher alert snapshot PNGs (warning polygon +
-- storm track over a Mapbox dark basemap, rendered by the Fly renderer's
-- /alert-snapshot endpoint). Public read so Telegram can fetch the URL we
-- attach as messages.media_url; writes are service-role only.
--
-- Mirrors radar-tiles (20260520010000_radar_tiles_bucket.sql).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'alert-snapshots',
    'alert-snapshots',
    true,
    5 * 1024 * 1024,            -- 5 MB hard ceiling per object (PNGs are ~150-400 KB)
    array['image/png']
)
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "alert-snapshots public read" on storage.objects;
create policy "alert-snapshots public read"
    on storage.objects for select
    using (bucket_id = 'alert-snapshots');

-- Daily sweeper: keep snapshots only as long as the alerts themselves stay
-- relevant. Alerts older than 24 h are well past their expires_at so the
-- snapshot is no longer useful in any open Telegram thread.
create extension if not exists pg_cron;

select cron.schedule(
    'alert-snapshots-sweep',
    '17 * * * *',
    $$
    delete from storage.objects
    where bucket_id = 'alert-snapshots'
      and created_at < now() - interval '24 hours'
    $$
);
