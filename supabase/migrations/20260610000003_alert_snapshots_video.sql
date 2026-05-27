-- Extend the alert-snapshots bucket to accept video/mp4 (for the new
-- /alert-loop endpoint's 30-min reflectivity loops) and bump the per-object
-- ceiling. Snapshots are still ~400 KB PNGs; loops are 1-5 MB MP4s at 720p
-- 4 fps × 6 frames. 8 MB ceiling leaves headroom without enabling abuse.
--
-- One bucket for both kinds of media keeps the existing hourly sweeper
-- (from 20260609000011_alert_snapshots_bucket.sql) covering both — no
-- second sweeper needed.

update storage.buckets
   set file_size_limit = 8 * 1024 * 1024,
       allowed_mime_types = array['image/png', 'video/mp4']
 where id = 'alert-snapshots';
