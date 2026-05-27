-- Tag where the subscriber's current location came from so the live-tracking
-- path can identify which rows belong to an active Telegram live share and
-- shouldn't be overwritten by stray static-location messages mid-share.
--
-- Values used today:
--   'telegram_live'   — a Telegram live-location share is in progress; the
--                       expires_at column tracks when the share auto-ends.
--   null              — anything else (static share, /where, home, signup).
--
-- Kept as plain text (not an enum) so we can add new sources without DDL
-- churn. No index — only read on per-row updates keyed by chat id.

alter table public.subscribers
  add column if not exists current_location_source text;

comment on column public.subscribers.current_location_source is
  'Source of the active current_location (e.g. ''telegram_live''). Null when no special source.';
