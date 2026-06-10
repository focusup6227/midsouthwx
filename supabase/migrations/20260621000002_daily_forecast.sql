-- Subscriber daily forecast digest (opt-in).
--
-- Subscribers toggle "Daily forecast" in the Telegram /prefs menu; the flag
-- lives in subscribers.alert_preferences->'daily_forecast' (default absent =
-- off) so no new column is needed and the existing prefs round-trip carries
-- it. Each morning a cron-invoked edge function (daily-forecast) groups
-- opted-in subscribers into ~11 km location buckets, fetches one NWS point
-- forecast per bucket, and fans each bucket out through the normal
-- messages → outbound_queue pipeline so delivery logs, recipient counts and
-- the dashboard all see it like any other send.

-- New message source for the digest. Safe inside the migration transaction
-- because nothing in this migration *uses* the value (PG12+ rule); the edge
-- function only references it at runtime.
alter type message_source add value if not exists 'forecast';

-- Recipients RPC: active subscribers who opted in and have a usable point.
-- Prefers the live `location` (temporary /where pin) over `home_location`
-- so a traveling subscriber gets the forecast for where they actually are.
create or replace function public.daily_forecast_recipients()
returns table (
  subscriber_id uuid,
  lat double precision,
  lon double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    s.id as subscriber_id,
    st_y(coalesce(s.location, s.home_location)::geometry) as lat,
    st_x(coalesce(s.location, s.home_location)::geometry) as lon
  from public.subscribers s
  where s.status = 'active'
    and s.telegram_chat_id is not null
    and coalesce(s.location, s.home_location) is not null
    and (s.alert_preferences ->> 'daily_forecast')::boolean is true;
$$;

revoke all on function public.daily_forecast_recipients() from public, anon, authenticated;
grant execute on function public.daily_forecast_recipients() to service_role;

-- Daily at 12:15 UTC — 7:15 AM CDT / 6:15 AM CST, after the default quiet
-- hours window (ends 07:00 CT) in summer; in winter the send worker delivers
-- silently inside quiet hours, so an early arrival never rings at 6 AM.
select cron.schedule(
  'daily-forecast',
  '15 12 * * *',
  $$
  select net.http_post(
    url := 'https://shaycvisygpxaogplylo.supabase.co/functions/v1/daily-forecast',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
