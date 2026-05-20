-- Storage bucket for the on-demand NEXRAD Level II renderer.
-- Public read so Mapbox can load PNGs directly without signed URLs;
-- writes restricted to the service role (used by the Fly renderer).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'radar-tiles',
    'radar-tiles',
    true,
    20 * 1024 * 1024,           -- 20 MB hard ceiling per object
    array['image/png']
)
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Anyone can read (PNGs are non-sensitive radar imagery).
drop policy if exists "radar-tiles public read" on storage.objects;
create policy "radar-tiles public read"
    on storage.objects for select
    using (bucket_id = 'radar-tiles');

-- Writes/updates/deletes happen server-side only via the service role,
-- which already bypasses RLS — so no insert/update/delete policy needed.

-- Hourly sweeper: drop objects older than 30 minutes so we don't accumulate
-- one PNG per scan forever. The renderer overwrites paths per scan_time, so
-- each KNQA reflectivity render produces ~12 distinct objects/hour worst case.
create extension if not exists pg_cron;

select cron.schedule(
    'radar-tiles-sweep',
    '*/15 * * * *',
    $$
    delete from storage.objects
    where bucket_id = 'radar-tiles'
      and created_at < now() - interval '30 minutes'
    $$
);
