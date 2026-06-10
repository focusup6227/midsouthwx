-- Subscriber value pack, part 1: closing the alert loop.
--
--   A. All-clear notifications — when a warning a subscriber was alerted for
--      ends and no other active warning covers their location, send a one-time
--      "✅ all clear" follow-up. Pure-SQL cron (like forecast-verify): finds
--      recently-ended warnings, derives the recipient set from the original
--      fan-out (outbound_queue), inserts one messages row per ended warning
--      with audience_spec={subscribers:[…]}, and enqueues through
--      enqueue_message_system — delivery logs and the dashboard see a normal
--      send. source='scheduled': non-life-safety in the worker (silent inside
--      quiet hours — good news shouldn't ring at 3 AM), no event-preference
--      filter at enqueue (everyone who got the warning gets the close), and
--      never eligible for the worker's source='nws' outbreak aggregation.
--
--   B. Severe-day heads-up — the first time each day a subscriber's location
--      falls inside an SPC Day-1 SLGT+ categorical polygon, send a morning
--      heads-up so warned-area subscribers go into the day weather-aware
--      instead of hearing from us only when a warning is already cutting
--      toward them. ENH/MDT/HIGH go to every active subscriber (rare,
--      high-signal); SLGT only to subscribers who opted into watches (their
--      "I want advance notice" signal). One notice per subscriber per
--      Central-time day, deduped in severe_day_notices.

-- ───────────────────────── A. All-clear ─────────────────────────

alter table public.nws_alerts
  add column if not exists all_clear_sent_at timestamptz;

create index if not exists nws_alerts_all_clear_idx
  on public.nws_alerts (expires_at)
  where all_clear_sent_at is null;

create or replace function public.dispatch_all_clears()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  w record;
  v_subs uuid[];
  v_msg uuid;
  v_dispatched int := 0;
begin
  for w in
    select a.id, a.event
    from public.nws_alerts a
    where a.event ilike '%warning%'
      and a.all_clear_sent_at is null
      and a.expires_at is not null
      and a.expires_at <= now()
      -- 45-min trailing window: cron runs every 5 min, so this is ample
      -- slack while keeping a backlog of stale alerts from mass-firing if
      -- the cron was paused.
      and a.expires_at > now() - interval '45 minutes'
      and exists (
        select 1
        from public.messages m
        join public.outbound_queue q on q.message_id = m.id and q.status = 'sent'
        where m.nws_alert_id = a.id
      )
    order by a.expires_at
    limit 20
  loop
    -- Recipients of the original warning who are still active and whose
    -- current location is NOT inside any other live warning polygon (if a
    -- successor warning covers them, it isn't clear yet — they'll get the
    -- all-clear when that one ends).
    select coalesce(array_agg(distinct q.subscriber_id), '{}') into v_subs
    from public.messages m
    join public.outbound_queue q on q.message_id = m.id and q.status = 'sent'
    join public.subscribers s on s.id = q.subscriber_id and s.status = 'active'
    where m.nws_alert_id = w.id
      and coalesce(s.location, s.home_location) is not null
      and not exists (
        select 1
        from public.nws_alerts o
        where o.id <> w.id
          and o.event ilike '%warning%'
          and o.status in ('new', 'dispatched')
          and o.polygon is not null
          and coalesce(o.expires_at, now() + interval '1 hour') > now()
          and st_intersects(o.polygon, coalesce(s.location, s.home_location))
      );

    -- Mark processed regardless of recipient count so we never re-evaluate.
    update public.nws_alerts set all_clear_sent_at = now() where id = w.id;

    if coalesce(array_length(v_subs, 1), 0) = 0 then
      continue;
    end if;

    insert into public.messages (body_md, body_rendered, source, status, audience_spec)
    values (
      '✅ **All clear** — the ' || w.event || ' for your area has ended, and no '
        || 'active warnings currently cover your location. Stay weather-aware; '
        || 'additional storms are possible. *Courtesy follow-up — always rely on '
        || 'official NWS warnings for life-safety decisions.*',
      '✅ **All clear** — the ' || w.event || ' for your area has ended, and no '
        || 'active warnings currently cover your location. Stay weather-aware; '
        || 'additional storms are possible. *Courtesy follow-up — always rely on '
        || 'official NWS warnings for life-safety decisions.*',
      'scheduled',
      'draft',
      jsonb_build_object('subscribers', to_jsonb(v_subs))
    )
    returning id into v_msg;

    perform public.enqueue_message_system(v_msg);
    v_dispatched := v_dispatched + 1;
  end loop;

  return v_dispatched;
end;
$$;

revoke all on function public.dispatch_all_clears() from public, anon, authenticated;
grant execute on function public.dispatch_all_clears() to service_role;

select cron.schedule(
  'all-clear-dispatch',
  '*/5 * * * *',
  $$ select public.dispatch_all_clears(); $$
);

-- ──────────────────── B. Severe-day heads-up ────────────────────

create table if not exists public.severe_day_notices (
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  outlook_day date not null,
  tier text not null,
  sent_at timestamptz not null default now(),
  primary key (subscriber_id, outlook_day)
);

alter table public.severe_day_notices enable row level security;

create policy "op severe_day_notices_select"
  on public.severe_day_notices for select
  using (public.is_operator());

create or replace function public.dispatch_severe_day_notices()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_today date := (now() at time zone 'America/Chicago')::date;
  t record;
  v_msg uuid;
  v_sent int := 0;
  v_tier_label text;
  v_body text;
begin
  for t in
    with feats as (
      select
        feature->'properties'->>'LABEL' as label,
        st_setsrid(st_geomfromgeojson(feature->'geometry'), 4326)::geography as geom
      from public.spc_outlooks o,
           jsonb_array_elements(o.geojson->'features') as feature
      where o.day_number = 1
        and coalesce(o.valid_until, now()) >= now()
        and feature->'geometry' is not null
        and feature->'properties'->>'LABEL' in ('SLGT', 'ENH', 'MDT', 'HIGH')
    ),
    ranked as (
      select
        s.id as subscriber_id,
        (s.alert_preferences->>'watches')::boolean is true as wants_watches,
        max(case f.label
              when 'HIGH' then 4
              when 'MDT'  then 3
              when 'ENH'  then 2
              else 1
            end) as tier_rank
      from public.subscribers s
      join feats f
        on st_intersects(f.geom, coalesce(s.location, s.home_location))
      where s.status = 'active'
        and s.telegram_chat_id is not null
        and coalesce(s.location, s.home_location) is not null
      group by s.id, s.alert_preferences
    )
    select r.tier_rank, array_agg(r.subscriber_id) as subs
    from ranked r
    where not exists (
        select 1 from public.severe_day_notices n
        where n.subscriber_id = r.subscriber_id
          and n.outlook_day = v_today
      )
      -- SLGT (rank 1) is common (~30 days/yr): only to watches opt-ins.
      -- ENH+ is rare and high-signal: everyone active in the polygon.
      and (r.tier_rank >= 2 or r.wants_watches)
    group by r.tier_rank
  loop
    v_tier_label := case t.tier_rank
      when 4 then 'High (5 of 5)'
      when 3 then 'Moderate (4 of 5)'
      when 2 then 'Enhanced (3 of 5)'
      else 'Slight (2 of 5)'
    end;

    v_body :=
      '⚠️ **Severe weather heads-up** — the Storm Prediction Center has placed '
      || 'your area under a **' || v_tier_label || '** severe thunderstorm risk '
      || 'for today. Stay weather-aware, keep your phone where you can hear it, '
      || 'and you''ll get an alert here if a warning is issued for your location.';

    insert into public.messages (body_md, body_rendered, source, status, audience_spec)
    values (
      v_body, v_body,
      'scheduled',  -- silent inside a subscriber's quiet hours; rings otherwise
      'draft',
      jsonb_build_object('subscribers', to_jsonb(t.subs))
    )
    returning id into v_msg;

    perform public.enqueue_message_system(v_msg);

    insert into public.severe_day_notices (subscriber_id, outlook_day, tier)
    select unnest(t.subs), v_today, v_tier_label
    on conflict (subscriber_id, outlook_day) do nothing;

    v_sent := v_sent + coalesce(array_length(t.subs, 1), 0);
  end loop;

  return v_sent;
end;
$$;

revoke all on function public.dispatch_severe_day_notices() from public, anon, authenticated;
grant execute on function public.dispatch_severe_day_notices() to service_role;

-- Hourly through the daytime window (12:40–23:40 UTC ≈ 7:40 AM–6:40 PM CDT):
-- catches the 12:30Z Day-1 update for the morning send, and later runs pick
-- up subscribers newly inside an upgraded outlook. The per-day dedup makes
-- repeat runs no-ops for anyone already notified.
select cron.schedule(
  'severe-day-heads-up',
  '40 12-23 * * *',
  $$ select public.dispatch_severe_day_notices(); $$
);

-- Retention: notices are tiny; prune after 90 days alongside other logs.
select cron.schedule(
  'severe-day-notices-prune',
  '25 3 * * *',
  $$ delete from public.severe_day_notices where sent_at < now() - interval '90 days'; $$
);
