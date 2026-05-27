-- F6 (per-hazard subscriber preferences): subscribers can opt out of a
-- specific hazard kind (skip flood, keep tornado) on top of the existing
-- category opt-outs (warnings/watches/advisories/statements).
--
-- Plumbing:
--   1. New immutable SQL classifier nws_event_hazard(text) → text, mirroring
--      the heuristics in lib/nws/radar.ts classifyNwsEvent().
--   2. alert_preferences JSON gains a `skip_hazards: text[]` array; default
--      empty. Backfilled on every existing row so the SQL gate doesn't have
--      to guard against the missing key.
--   3. subscriber_wants_nws_event() now AND-checks: category enabled AND
--      hazard not in skip_hazards. Manual / scheduled / checkin messages
--      bypass the function entirely (see enqueue_message_system source-
--      branching), so this only affects NWS-triggered fan-out.

-- 1. Hazard classifier. Heuristics MUST stay in lockstep with
--    `classifyNwsEvent` in /Users/tylerdixon/Desktop/midsouthwx-main/lib/nws/radar.ts —
--    if you add a hazard kind there, add a branch here.
create or replace function public.nws_event_hazard(p_event text)
returns text
language sql
immutable
as $$
  select case
    when p_event ilike '%tornado%' then 'tornado'
    when p_event ilike '%severe thunderstorm%' then 'severe'
    when p_event ilike '%flood%' then 'flood'           -- covers 'flash flood' too
    when p_event ilike '%winter%'
      or p_event ilike '%ice%'
      or p_event ilike '%blizzard%'
      or p_event ilike '%freeze%' then 'winter'
    when p_event ilike '%heat%' then 'heat'
    when p_event ilike '%wind%' or p_event ilike '%gale%' then 'wind'
    else 'other'
  end;
$$;

revoke all on function public.nws_event_hazard(text) from public, anon;
grant execute on function public.nws_event_hazard(text) to authenticated, service_role;

-- 2a. Update the column default for new rows.
alter table public.subscribers
  alter column alert_preferences set default '{
    "warnings": true,
    "watches": true,
    "advisories": true,
    "statements": false,
    "skip_hazards": []
  }'::jsonb;

-- 2b. Backfill existing rows that don't already have the key.
update public.subscribers
set alert_preferences = alert_preferences || jsonb_build_object('skip_hazards', '[]'::jsonb)
where not (alert_preferences ? 'skip_hazards');

comment on column public.subscribers.alert_preferences is
  'JSON: warnings, watches, advisories, statements (bool) + skip_hazards '
  '(text[] of tornado|severe|flood|winter|heat|wind). NWS auto-alerts only.';

-- 3. Combined category + hazard gate. Returns true iff the subscriber's
-- prefs allow the event's category AND its hazard is not in skip_hazards.
-- A missing subscriber row, missing prefs, or missing keys all default to
-- "allow" so a config gap never silently drops alerts.
create or replace function public.subscriber_wants_nws_event(
  p_subscriber_id uuid,
  p_event text
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (
      select
        coalesce((s.alert_preferences ->> public.nws_event_category(p_event))::boolean, true)
        and not coalesce(
          (s.alert_preferences -> 'skip_hazards') @> to_jsonb(public.nws_event_hazard(p_event)),
          false
        )
      from public.subscribers s
      where s.id = p_subscriber_id
        and s.status = 'active'
    ),
    true
  );
$$;

revoke all on function public.subscriber_wants_nws_event(uuid, text) from public, anon;
grant execute on function public.subscriber_wants_nws_event(uuid, text) to authenticated, service_role;
