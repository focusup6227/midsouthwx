# Severe Weather Alert Dashboard — Implementation Plan

Single-operator severe weather alert system. Supabase backend, Next.js PWA frontend, Telegram as the sole delivery channel (DMs only). Built phased: v1 ships manual alerts + groups + replies; NWS automation and scheduling layer on after.

---

## 0. Locked decisions (2026-05-18)

1. **Location at signup:** ZIP **and** optional browser geolocation lat/lng. ZIP is required; lat/lng is opt-in for better polygon matching.
2. **Operator auth:** magic-link only to `tylerleedixon@gmail.com`.
3. **Signup model:** open public form + Telegram /start handshake. Rate-limited Edge Function with Turnstile CAPTCHA.
4. **NWS coverage:** scales with subscribers — no fixed area filter. Poll `/alerts/active` nationally and match against subscriber locations via PostGIS.
5. **Hosting:** Vercel Hobby.
6. **Audience resolution:** single SQL function `public.resolve_audience(spec jsonb)` called from both preview and queue insertion. No duplicate TS logic.

Defaults applied without re-prompting:
- NWS rules: whitelist via `auto_alert_rules`, seeded with Tornado/Severe Thunderstorm/Flash Flood/Winter Storm Warnings.
- Retention: 2 years on replies + delivery_logs + nws_alerts.
- Map tiles: MapLibre GL + OSM (no key) for most pages; radar (/radar) uses Mapbox GL + OSM Streets dark-v11 (free token) for superior dark theme, built-in political boundaries and place labels. Radar includes site chooser, quality toggle (LibreWxR high-res for reflectivity; RainViewer-compatible v2 API), and area draw alerts.
- Push: Web Push + Telegram self-notify (both).

---

## 1. Architecture

```
                          ┌────────────────────────────────────────────┐
                          │            Operator (you, mobile/desktop)  │
                          │                                            │
                          │      Next.js PWA (Vercel)                  │
                          │   ┌──────────────────────────────────┐     │
                          │   │ Compose · Inbox · Map · Schedule │     │
                          │   │ Check-ins · NWS approvals · Subs │     │
                          │   └──────────────────────────────────┘     │
                          └──────────────┬─────────────────────────────┘
                                         │  @supabase/ssr (Auth, REST, Realtime)
                                         ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                          Supabase Project                            │
   │                                                                      │
   │   Postgres + PostGIS  ◄──── pg_cron  ────►  Edge Functions          │
   │   ├─ subscribers (geog)             ┌─────►  telegram-webhook       │
   │   ├─ regions (geog)                 │       (inbound: /start,        │
   │   ├─ groups                         │        replies, callbacks)     │
   │   ├─ messages / outbound_queue  ────┼─────►  telegram-send-worker    │
   │   ├─ replies / conversations        │       (drains queue,           │
   │   ├─ nws_alerts / auto_alert_rules ─┼─────►  rate-limited send)      │
   │   ├─ scheduled_messages             │                                │
   │   └─ delivery_logs / check_ins      ├─────►  nws-poll                │
   │                                     │       (api.weather.gov)        │
   │   Realtime ──► dashboard inbox      │                                │
   │   Auth (magic link)                 ├─────►  nws-dispatcher          │
   │   Secrets (TG bot token, NWS UA)    │       (match polygons,         │
   │                                     │        send or queue review)   │
   │                                     └─────►  scheduled-dispatcher    │
   └─────────────────────────────┬───────────────────────────────────────┘
                                 │ HTTPS
                                 ▼
                       ┌──────────────────────┐
                       │ Telegram Bot API     │
                       │ + api.weather.gov    │
                       └─────────┬────────────┘
                                 │ DMs
                                 ▼
                   ┌───────────────────────────┐
                   │ Subscribers (one DM each) │
                   └───────────────────────────┘
```

**Key flows:**
- **Outbound alert:** operator clicks Send → server action resolves audience to subscriber IDs (de-duped) → bulk-insert into `outbound_queue` → Realtime ticks recipient counter → `telegram-send-worker` (pg_cron every minute) drains queue at ≤25 msg/s → updates `delivery_logs` → Realtime updates dashboard.
- **Inbound reply:** Telegram → `telegram-webhook` (signature-verified) → insert into `replies` → Realtime pushes to inbox.
- **NWS auto-alert:** `nws-poll` (every 60s) → upsert `nws_alerts` → trigger fires `nws-dispatcher` → matches subscribers by `ST_Intersects` (polygon) or county_fips (zone) → applies `auto_alert_rules` → either enqueues immediately or sets `messages.status='pending_approval'` for operator review.

---

## 2. Tech stack & rationale

| Layer | Choice | Why |
|---|---|---|
| DB | Supabase Postgres + PostGIS | Required for polygon matching; pg_cron + Realtime + RLS in one place |
| Auth | Supabase Auth, magic link | One operator, no password to lose |
| Backend logic | Supabase Edge Functions (Deno) | Native to the platform; cheap; fast cold starts |
| Cron | pg_cron + `net.http_post` | Triggers Edge Functions on schedule; no external scheduler |
| Frontend | Next.js 14 App Router | Best Supabase SSR story (`@supabase/ssr`), mobile-friendly, PWA-ready |
| UI | Tailwind + shadcn/ui | Touch-friendly out of the box, easy theming |
| Map | MapLibre GL + OSM tiles | No API key for most views; radar uses Mapbox (free token) dark OSM with native boundaries/labels + IEM/LibreWxR radar |
| Editor | `react-markdown` + textarea or `@uiw/react-md-editor` | Markdown is enough; no need for a heavy WYSIWYG |
| PWA | `next-pwa` (Workbox) | Service worker + manifest + Web Push hooks |
| Hosting | Vercel | Free tier covers it; preview branches; Edge runtime if needed |

---

## 3. Database schema

SQL below is the v1 migration set. Each block is one migration file. RLS shown inline; storage is not needed in v1.

### 3.1 Extensions and helpers

```sql
-- 0001_extensions.sql
create extension if not exists postgis;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto;

create schema if not exists private;  -- for security definer fns + secrets accessors

-- One-row table identifying the operator. Lets RLS check "is this auth.uid the operator?"
create table public.operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  telegram_chat_id bigint,  -- for self-notify
  created_at timestamptz default now()
);
alter table public.operators enable row level security;
create policy "operator reads self" on public.operators
  for select using (user_id = auth.uid());

-- No SECURITY DEFINER: the operator's SELECT policy on `operators` already lets
-- them read their own row, so SECURITY INVOKER is enough. Keeps a privileged
-- function out of the exposed `public` schema.
create or replace function public.is_operator() returns boolean
language sql stable as $$
  select exists (select 1 from public.operators where user_id = auth.uid());
$$;
```

### 3.2 Subscribers + geographic regions

```sql
-- 0002_subscribers.sql
create type subscriber_status as enum ('pending', 'active', 'paused', 'unsubscribed');

create table public.subscribers (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint unique,
  telegram_username text,
  display_name text not null,
  phone text,
  email text,
  location geography(Point, 4326),
  zip text,
  county_fips text,
  status subscriber_status not null default 'pending',
  link_token text unique,        -- handed out by signup form, redeemed via /start
  link_expires_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index subscribers_location_gix on public.subscribers using gist (location);
create index subscribers_county on public.subscribers (county_fips);
create index subscribers_status on public.subscribers (status);

create table public.regions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('county','zone','custom_polygon')),
  county_fips text,
  ugc_code text,                 -- NWS forecast zone, e.g. NCZ001
  geometry geography(MultiPolygon, 4326),
  created_at timestamptz default now()
);
create index regions_geometry_gix on public.regions using gist (geometry);
create unique index regions_county_uniq on public.regions(county_fips) where county_fips is not null;
create unique index regions_ugc_uniq on public.regions(ugc_code) where ugc_code is not null;

-- Maintained by trigger: which regions a subscriber falls into
create table public.subscriber_regions (
  subscriber_id uuid references public.subscribers(id) on delete cascade,
  region_id uuid references public.regions(id) on delete cascade,
  primary key (subscriber_id, region_id)
);

create or replace function private.refresh_subscriber_regions(p_sub uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.subscriber_regions where subscriber_id = p_sub;
  insert into public.subscriber_regions (subscriber_id, region_id)
  select p_sub, r.id from public.regions r, public.subscribers s
  where s.id = p_sub
    and (
      (s.location is not null and r.geometry is not null and st_intersects(s.location, r.geometry))
      or (s.county_fips is not null and r.county_fips = s.county_fips)
    );
end$$;

create or replace function private.sub_regions_trigger() returns trigger
language plpgsql as $$
begin
  perform private.refresh_subscriber_regions(new.id);
  return new;
end$$;

create trigger sub_regions_after_change
after insert or update of location, county_fips on public.subscribers
for each row execute function private.sub_regions_trigger();

-- A region's geometry or county_fips changing must re-match all subscribers,
-- otherwise newly-added/edited regions silently miss existing subscribers.
create or replace function private.rebuild_region_memberships(p_region uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.subscriber_regions where region_id = p_region;
  insert into public.subscriber_regions (subscriber_id, region_id)
  select s.id, r.id
  from public.subscribers s, public.regions r
  where r.id = p_region
    and (
      (s.location is not null and r.geometry is not null and st_intersects(s.location, r.geometry))
      or (s.county_fips is not null and r.county_fips = s.county_fips)
    );
end$$;

create or replace function private.regions_trigger() returns trigger
language plpgsql as $$
begin
  perform private.rebuild_region_memberships(new.id);
  return new;
end$$;

create trigger regions_after_change
after insert or update of geometry, county_fips on public.regions
for each row execute function private.regions_trigger();

alter table public.subscribers enable row level security;
alter table public.regions enable row level security;
alter table public.subscriber_regions enable row level security;

-- All subscriber/region access is operator-only via the dashboard.
create policy "operator full access subscribers" on public.subscribers
  for all using (public.is_operator()) with check (public.is_operator());
create policy "operator full access regions" on public.regions
  for all using (public.is_operator()) with check (public.is_operator());
create policy "operator full access subscriber_regions" on public.subscriber_regions
  for all using (public.is_operator()) with check (public.is_operator());

-- IMPORTANT: public signup does NOT hit subscribers directly. The signup Edge Function
-- runs as service_role, validates input, and writes here. The anon role gets NO
-- access to this table.
```

### 3.3 Groups

```sql
-- 0003_groups.sql
create table public.custom_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_at timestamptz default now()
);
create table public.group_memberships (
  group_id uuid references public.custom_groups(id) on delete cascade,
  subscriber_id uuid references public.subscribers(id) on delete cascade,
  added_at timestamptz default now(),
  primary key (group_id, subscriber_id)
);
alter table public.custom_groups enable row level security;
alter table public.group_memberships enable row level security;
create policy "op groups" on public.custom_groups
  for all using (public.is_operator()) with check (public.is_operator());
create policy "op group memberships" on public.group_memberships
  for all using (public.is_operator()) with check (public.is_operator());
```

### 3.4 Messages, queue, delivery

```sql
-- 0004_messaging.sql
create type message_source as enum ('manual','scheduled','nws','checkin');
create type message_status as enum ('draft','pending_approval','queued','sending','sent','failed','cancelled');
create type outbound_status as enum ('pending','sending','sent','failed','skipped');
create type delivery_event as enum ('queued','sent','delivered','failed','read');

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text,                            -- 'tornado','flood','checkin','test'
  body_md text not null,
  default_quick_replies jsonb,              -- [{label,'callback_data'},...]
  created_at timestamptz default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  body_md text not null,
  body_rendered text,                       -- plain text or HTML rendered for Telegram
  source message_source not null default 'manual',
  status message_status not null default 'draft',
  audience_spec jsonb not null,             -- {regions:[...], groups:[...], subscribers:[...], all:false}
  quick_replies jsonb,                      -- carried through to TG inline keyboard
  template_id uuid references public.templates(id),
  nws_alert_id uuid,                        -- FK added in 0006
  recipient_count int default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  sent_at timestamptz
);
create index messages_status_idx on public.messages(status);
create index messages_created_idx on public.messages(created_at desc);

create table public.outbound_queue (
  id bigserial primary key,
  message_id uuid not null references public.messages(id) on delete cascade,
  subscriber_id uuid not null references public.subscribers(id),
  status outbound_status not null default 'pending',
  telegram_message_id bigint,
  attempts int not null default 0,
  last_error text,
  send_after timestamptz default now(),
  locked_at timestamptz,
  locked_by text,
  sent_at timestamptz,
  created_at timestamptz default now()
);
create index outbound_due_idx on public.outbound_queue (status, send_after) where status = 'pending';
create unique index outbound_one_per_msg on public.outbound_queue (message_id, subscriber_id);

create table public.delivery_logs (
  id bigserial primary key,
  outbound_id bigint references public.outbound_queue(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  subscriber_id uuid references public.subscribers(id),
  event delivery_event not null,
  meta jsonb,
  occurred_at timestamptz default now()
);

alter table public.templates enable row level security;
alter table public.messages enable row level security;
alter table public.outbound_queue enable row level security;
alter table public.delivery_logs enable row level security;
create policy "op templates" on public.templates for all using (public.is_operator()) with check (public.is_operator());
create policy "op messages" on public.messages for all using (public.is_operator()) with check (public.is_operator());
create policy "op queue read" on public.outbound_queue for select using (public.is_operator());
create policy "op delivery read" on public.delivery_logs for select using (public.is_operator());
-- Worker writes via service_role (bypasses RLS).
```

### 3.5 Replies, conversations, check-ins

```sql
-- 0005_inbox.sql
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null unique references public.subscribers(id) on delete cascade,
  last_message_at timestamptz,
  unread_count int not null default 0,
  pinned boolean default false
);

create table public.replies (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  subscriber_id uuid not null references public.subscribers(id),
  parent_message_id uuid references public.messages(id),  -- inferred via TG reply_to or recency
  body text,
  callback_data text,                                     -- non-null when reply came from a quick-reply button
  telegram_message_id bigint,
  is_distress boolean default false,                      -- keyword-flagged
  read_at timestamptz,
  received_at timestamptz default now()
);
create index replies_conv_idx on public.replies(conversation_id, received_at desc);
create index replies_unread_idx on public.replies(read_at) where read_at is null;

create table public.check_in_responses (
  message_id uuid not null references public.messages(id) on delete cascade,
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  response_code text,                                     -- 'safe','need_help','sheltering', etc.
  free_text text,
  responded_at timestamptz default now(),
  primary key (message_id, subscriber_id)
);

alter table public.conversations enable row level security;
alter table public.replies enable row level security;
alter table public.check_in_responses enable row level security;
create policy "op conv" on public.conversations for all using (public.is_operator()) with check (public.is_operator());
create policy "op replies" on public.replies for all using (public.is_operator()) with check (public.is_operator());
create policy "op checkins" on public.check_in_responses for all using (public.is_operator()) with check (public.is_operator());
```

### 3.6 NWS alerts + auto-rules + scheduled messages

```sql
-- 0006_nws_scheduling.sql
create type nws_status as enum ('new','dispatched','superseded','cancelled','expired');
create type rule_mode as enum ('auto','review','ignore');

create table public.nws_alerts (
  id uuid primary key default gen_random_uuid(),
  nws_id text not null unique,           -- the @id from api.weather.gov
  event text not null,                    -- 'Tornado Warning'
  severity text,                          -- 'Extreme','Severe',...
  certainty text,
  urgency text,
  headline text,
  description text,
  instruction text,
  area_desc text,
  ugc_codes text[],                       -- ['NCZ001','NCZ002',...]
  same_codes text[],                      -- ['037183',...]  (county FIPS)
  polygon geography(MultiPolygon, 4326),
  sent_at timestamptz,
  effective timestamptz,
  expires_at timestamptz,
  status nws_status not null default 'new',
  references_ids text[],                  -- prior @id values this update/cancel refers to
  raw jsonb,
  ingested_at timestamptz default now()
);
create index nws_polygon_gix on public.nws_alerts using gist (polygon);
create index nws_status_idx on public.nws_alerts (status, ingested_at desc);

alter table public.messages
  add constraint messages_nws_alert_fk
  foreign key (nws_alert_id) references public.nws_alerts(id) on delete set null;

create table public.auto_alert_rules (
  id uuid primary key default gen_random_uuid(),
  event_pattern text not null,           -- exact match or wildcard, e.g. 'Tornado Warning'
  min_severity text,                      -- only fire if severity >= this
  mode rule_mode not null default 'review',
  region_filter jsonb,                    -- {region_ids:[...]} or null for "any matching"
  template_id uuid references public.templates(id),
  enabled boolean not null default true,
  created_at timestamptz default now()
);

create type schedule_status as enum ('pending','sent','cancelled','skipped','failed');

create table public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  body_md text not null,
  audience_spec jsonb not null,
  scheduled_for timestamptz not null,
  rrule text,                            -- RFC 5545 recurrence; null for one-shot
  next_run_at timestamptz,               -- maintained by trigger / dispatcher
  send_window_minutes int default 15,
  status schedule_status not null default 'pending',
  template_id uuid references public.templates(id),
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);
create index sched_due_idx on public.scheduled_messages (next_run_at) where status = 'pending';

alter table public.nws_alerts enable row level security;
alter table public.auto_alert_rules enable row level security;
alter table public.scheduled_messages enable row level security;
create policy "op nws read" on public.nws_alerts for select using (public.is_operator());
create policy "op rules" on public.auto_alert_rules for all using (public.is_operator()) with check (public.is_operator());
create policy "op sched" on public.scheduled_messages for all using (public.is_operator()) with check (public.is_operator());
```

### 3.7 pg_cron schedules

```sql
-- 0007_cron.sql
-- All Edge Function invocations go through pg_net, signed with the cron secret stored in vault.
-- (Replace <PROJECT_REF> at migration apply time; or pull from a vault secret.)
select cron.schedule(
  'nws-poll',  '* * * * *',
  $$ select net.http_post(
       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/nws-poll',
       headers := jsonb_build_object('Authorization', 'Bearer ' || vault.read_secret('cron_invoker_jwt'))
     ); $$
);
select cron.schedule(
  'send-worker', '* * * * *',
  $$ select net.http_post(
       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/telegram-send-worker',
       headers := jsonb_build_object('Authorization', 'Bearer ' || vault.read_secret('cron_invoker_jwt'))
     ); $$
);
select cron.schedule(
  'scheduled-dispatcher', '* * * * *',
  $$ select net.http_post(
       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/scheduled-dispatcher',
       headers := jsonb_build_object('Authorization', 'Bearer ' || vault.read_secret('cron_invoker_jwt'))
     ); $$
);
```

`telegram-send-worker` should itself loop several times per invocation (e.g., 10 batches × 25 msgs = 250 msgs/minute) since pg_cron's smallest interval is 1 minute. If you need bursty throughput beyond that, the worker can self-reinvoke via fetch.

---

## 4. Edge Functions

All under `supabase/functions/`. Deno + TypeScript. Each verifies its caller (HMAC for Telegram, cron JWT for internal calls).

| Function | Trigger | Responsibility |
|---|---|---|
| `signup` | HTTPS (public, rate-limited) | Validates form input, geocodes ZIP → county_fips, generates `link_token`, inserts subscriber with `status='pending'`, returns deep-link URL to bot |
| `telegram-webhook` | Telegram (HTTPS) | Verifies `X-Telegram-Bot-Api-Secret-Token` header; routes `/start <token>` (claims subscriber), location updates, `/unsubscribe`, free-text replies (→ `replies`), callback queries (→ `check_in_responses` + `replies`); upserts conversation; self-notifies operator on distress keywords |
| `telegram-send-worker` | pg_cron (1/min) | Locks up to N queued rows with `for update skip locked`, sends to Telegram Bot API at ≤25 msg/s using token bucket, retries on 5xx and 429 (respects `retry_after`), updates `outbound_queue` + `delivery_logs` |
| `nws-poll` | pg_cron (1/min) | Fetches `https://api.weather.gov/alerts/active` for configured area/feed, upserts into `nws_alerts` keyed on `nws_id`, marks superseded/cancelled per `references`; emits a Postgres `NOTIFY` so the dispatcher fires synchronously when needed |
| `nws-dispatcher` | DB trigger on `nws_alerts` INSERT (via `pg_net`) | For each new alert, evaluates `auto_alert_rules`, computes affected subscribers (polygon ∩ subscriber.location OR UGC/SAME match), inserts a `messages` row (`status='queued'` if `auto`, `'pending_approval'` if `review`), populates `outbound_queue` |
| `scheduled-dispatcher` | pg_cron (1/min) | Picks `scheduled_messages` where `next_run_at <= now()`, validates send-window relevance, materializes a `messages` row + queue rows, advances `next_run_at` per RRULE |
| `self-notify` (helper, callable from others) | internal | DMs the operator's own Telegram chat for distress replies, NWS auto-fires, approval-required messages |

Function-level secrets (set with `supabase secrets set`):
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPERATOR_TELEGRAM_CHAT_ID`, `NWS_USER_AGENT` (NWS requires a contact UA string), `SUPABASE_SERVICE_ROLE_KEY`, `CRON_INVOKER_JWT`.

---

## 5. Telegram integration details

- **Bot setup:** create with @BotFather, set commands (`start`, `location`, `unsubscribe`, `help`), set webhook to `https://<PROJECT>.supabase.co/functions/v1/telegram-webhook` with `secret_token` matching `TELEGRAM_WEBHOOK_SECRET`.
- **Link flow:** signup form → `link_token` returned → user opens `https://t.me/<BotName>?start=<token>` → bot’s `/start <token>` handler claims the row and flips `status='active'`.
- **Rate limiting:** Telegram caps ~30 different-user messages/sec. Worker uses 25/s with a 200ms safety margin. On 429, sleep `retry_after` seconds and re-queue.
- **Quick replies:** outgoing message includes inline keyboard with `callback_data`. Webhook handles `callback_query`, answers it (banner toast on user's side), and writes a row into `check_in_responses` keyed on `(message_id, subscriber_id)` plus a `replies` entry so it shows in the inbox.
- **Delivery status:** Telegram does *not* expose read receipts for bots. "Delivered" = `sendMessage` returned 200. "Read" is unavailable; UI should not promise it. We can infer "read" if the subscriber sent any message in the chat after the alert was sent.

---

## 6. NWS integration details

- **Source:** `https://api.weather.gov/alerts/active` filtered by `area=<state>` or by polygon of interest. NWS requires a `User-Agent: AppName (contact)` header.
- **Matching strategy (in dispatcher):**
  1. If alert has `geometry` polygon → `select s.id from subscribers s where st_intersects(s.location, $polygon)`.
  2. Else fall back to `same` (county FIPS) and `ugc` (forecast zone) arrays: `where s.county_fips = any($same_codes) or exists (select 1 from subscriber_regions sr join regions r on r.id = sr.region_id where sr.subscriber_id = s.id and r.ugc_code = any($ugc_codes))`.
- **Deduplication:** key on `nws_id`. When an update arrives with `references`, mark the referenced alerts `superseded` and only send the diff if our rule says so.
- **Rule example:** `event='Tornado Warning', min_severity='Severe', mode='auto'` → fires immediately. `event='Severe Thunderstorm Watch', mode='review'` → drafts the message and self-notifies you.

---

## 7. Frontend (Next.js App Router)

```
/app
  /login                     magic-link form
  /(dash)
    /                        home: pending approvals, unread inbox, recent alerts
    /compose                 audience picker + markdown editor + preview
    /inbox                   conversations list + thread view (Realtime)
    /inbox/[subscriberId]    thread view, reply form
    /subscribers             table, search, filter by region/group
    /subscribers/[id]        detail, edit, regions/groups, history
    /groups                  list + create/edit
    /regions                 list + map view
    /map                     full-screen subscriber distribution map
    /schedule                pending + recurring schedules
    /checkins                live check-in tally view (Realtime per message)
    /nws                     active alerts, pending approvals, rule editor
    /alerts                  audit log
    /settings                operator profile, bot config, templates
/lib
  supabase/server.ts         createServerClient with cookies
  supabase/client.ts         createBrowserClient
  audience.ts                resolve audience_spec → subscriber_ids (de-duped)
  telegram.ts                shared types
  nws.ts                     types + formatter for headline → markdown
/components
  AudiencePicker, MessageEditor, RecipientPreview, InboxList, ThreadView,
  CheckinTally, MapView, NWSCard, ScheduleList, FieldModeToggle
/public
  manifest.json, icons, sw.js (next-pwa)
```

**Field mode:** a single toggle in the header that sets a `field-mode` cookie. Server components render a simplified layout: bigger touch targets, only Compose / Inbox / Approve / Check-in tiles, no tables.

---

## 8. PWA + push notifications

- `next-pwa` produces the service worker and manifest. Add `apple-touch-icon` + iOS install instructions to the login page (iOS PWA push requires the user to install first).
- Web Push: use `web-push` library inside an Edge Function. Subscribe endpoint stored per-operator in `operator_push_subscriptions`. Fire push from `self-notify` helper.
- Telegram self-notify is the more reliable channel — it bypasses browser push permission entirely and rings your phone via Telegram's normal notification.

---

## 9. Security

- **Operator-only data:** every dashboard table has RLS `using (public.is_operator())`. The `anon` and `authenticated` roles get no grants on `subscribers`/`replies`/etc. — the only public surface is the `signup` Edge Function, which runs as service_role.
- **Webhook auth:** `telegram-webhook` requires the `X-Telegram-Bot-Api-Secret-Token` header to equal `TELEGRAM_WEBHOOK_SECRET`. Reject all others with 401.
- **Cron auth:** Edge Functions invoked by pg_cron check a shared `CRON_INVOKER_JWT`. The token lives in Vault.
- **Signup abuse:** `signup` function rate-limits by IP (e.g., 5/hour) using a `signup_attempts` table or Upstash Redis. CAPTCHA (Cloudflare Turnstile) on the form.
- **No `user_metadata` for authorization** — operator membership comes from `public.operators`, not JWT claims.
- **Views:** none in v1; if added later, use `security_invoker = true`.
- **Storage:** not used in v1. If you later attach radar images, gate uploads behind a server action that writes via service_role.
- **Bot token:** Supabase secrets only; never `NEXT_PUBLIC_`.

---

## 10. Phased milestones

### v1 — usable manual alerts (target: 1–2 weekends of work)
- Migrations 0001–0005 (no NWS, no scheduling tables yet)
- Edge Functions: `signup`, `telegram-webhook`, `telegram-send-worker`
- pg_cron: `send-worker` only
- Frontend pages: login, home (last 10 alerts + unread), compose with audience picker, inbox + thread, subscribers list/detail, groups list/detail, settings
- Realtime: inbox, delivery_logs
- Templates table seeded with 5 starter templates
- Check-in mode implemented (it's just a message with quick replies — no extra tables besides `check_in_responses`)
- PWA install + Telegram self-notify

**Exit criterion:** you can sign up 5 test subscribers, link them via /start, send a compose-built alert to a custom group, see replies in the inbox, run a family check-in and see safe/need-help tallies on your phone.

### v2 — scheduling
- Migration 0006 (scheduling fields only)
- Edge Function: `scheduled-dispatcher`
- pg_cron: `scheduled-dispatcher`
- Frontend: `/schedule` page (list + create + edit + cancel + recurrence with rrule helper)
- Send-window logic for non-NWS schedules: require operator confirm via Telegram self-notify with inline approve button

**Exit criterion:** schedule a weekly Sunday test-alert that fires reliably.

### v3 — NWS automation
- Migration 0006 (rest of it: `nws_alerts`, `auto_alert_rules`)
- Edge Functions: `nws-poll`, `nws-dispatcher`
- pg_cron: `nws-poll`
- Frontend: `/nws` (active alerts, pending approvals, rule editor)
- Backfill `regions` for your operating area (counties + UGC zones from NWS reference data)

**Exit criterion:** a real Tornado Warning issued in your area triggers either (a) an auto-send to the matching audience or (b) an approval card in your dashboard within ~2 minutes end-to-end. (pg_cron's smallest interval is 1 minute; if you want closer to 30s, have `nws-poll` self-reinvoke twice per minute within its run window, same pattern as `telegram-send-worker`.)

### v4 — polish
- Web Push (in addition to Telegram self-notify)
- Distress-keyword detector tuned and tested
- Audit log export (CSV)
- Map heatmap by region (count of subscribers)
- Templates with variable substitution (`{{event}}`, `{{expires_at}}`)

---

## 11. Cost estimate

| Item | Tier | Cost |
|---|---|---|
| Supabase | Pro | $25/mo (covers Edge Functions, pg_cron, daily backups, 8 GB DB, 250 GB egress) |
| Vercel | Hobby | $0 (one operator, well under limits) |
| Telegram Bot | — | Free |
| api.weather.gov | — | Free (requires UA) |
| Domain (optional) | — | $12/yr |

**Why Pro from day one:** Free tier pauses projects after a week of inactivity. For a severe weather use case, that's unacceptable — you don't want to discover the dashboard is asleep when a tornado warning drops.

Scales comfortably to ~5–10k subscribers and ~100k messages/month on Pro. Past that, audit egress and consider Team tier.

---

## 12. Repo bootstrap (when you're ready to start)

```
bad-weather/
├── .env.local                # NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY (publishable)
├── app/                      # Next.js App Router
├── components/
├── lib/
├── public/
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 0001_extensions.sql
│   │   ├── 0002_subscribers.sql
│   │   ├── 0003_groups.sql
│   │   ├── 0004_messaging.sql
│   │   ├── 0005_inbox.sql
│   │   ├── 0006_nws_scheduling.sql      # v2/v3
│   │   └── 0007_cron.sql                 # v2/v3
│   ├── functions/
│   │   ├── signup/
│   │   ├── telegram-webhook/
│   │   ├── telegram-send-worker/
│   │   ├── scheduled-dispatcher/         # v2
│   │   ├── nws-poll/                     # v3
│   │   └── nws-dispatcher/               # v3
│   └── seed.sql                          # starter templates, your operator row, default rules
├── PLAN.md                               # this doc
├── package.json
└── README.md
```

Boot commands once decisions above are confirmed:

```bash
npx create-next-app@latest bad-weather --ts --tailwind --app --eslint
cd bad-weather
npm i @supabase/ssr @supabase/supabase-js maplibre-gl @uiw/react-md-editor next-pwa zod date-fns rrule
npx shadcn@latest init
supabase init
supabase login
supabase link --project-ref <YOUR_REF>
supabase migration new extensions    # then paste 0001 content; repeat per file
```

---

## 13. Open questions for you

In order of "will block v1 code":

1. **(blocks 0002)** ZIP-only vs ZIP + lat/lng at signup? → see §0.1
2. **(blocks 0001)** What email do you want for magic-link operator login? Same as `tylerleedixon@gmail.com`?
3. **(blocks `signup` fn)** Open signup form, or invite-only first?
4. **(blocks v3)** Which states/counties do you cover? (Determines NWS poll filter and seeded regions.)
5. **(non-blocking)** Vercel hosting OK, or want a self-hosted alternative?
6. **(non-blocking, worth deciding early)** Audience resolution lives in two places by default: `lib/audience.ts` for the dashboard preview count, and the server action that inserts into `outbound_queue`. Preference for putting it in a single SQL function `public.resolve_audience(audience_spec jsonb) returns setof uuid` called from both? That guarantees "preview count = actual queued count" forever. Slightly more SQL up front, no drift later.

Once these are answered I can start v1 code: migrations + the three Edge Functions + the compose/inbox pages.
