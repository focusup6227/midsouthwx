# midsouthwx

Severe weather alert dashboard. Single operator, Telegram delivery, Supabase backend, Next.js PWA frontend. See [`PLAN.md`](./PLAN.md) for the full architecture.

## v1 setup (one-time)

You'll do three things outside the repo, then everything else is in here.

### 1 — Create the Supabase project

1. Go to <https://supabase.com/dashboard/new> and create a project. Pro tier ($25/mo) is recommended because Free pauses after inactivity.
2. Once it's up, grab three values from **Project Settings → API**:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - Publishable key → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or legacy JWT `NEXT_PUBLIC_SUPABASE_ANON_KEY`; the app accepts either)
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server-only, never ship to the browser)

### 2 — Create the Telegram bot

1. Open Telegram, message [@BotFather](https://t.me/BotFather), `/newbot`.
2. Pick a username (e.g. `MidSouthWxBot`). Save the username and the bot token BotFather gives you.
3. Get your own Telegram chat ID (DM [@userinfobot](https://t.me/userinfobot)) — needed for the operator self-notify.

## Install + run locally

```bash
# from the repo root
npm install

# Supabase CLI (one-time install if you don't have it)
brew install supabase/tap/supabase   # macOS
# or: see https://supabase.com/docs/guides/cli for Linux/Windows

supabase login
supabase link --project-ref <YOUR_PROJECT_REF>

# Apply migrations + seed
supabase db push
supabase db query "$(cat supabase/seed.sql)"

# Set Edge Function secrets (server-side env)
supabase secrets set TELEGRAM_BOT_TOKEN=<token>
supabase secrets set TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24)
supabase secrets set TELEGRAM_BOT_USERNAME=<bot username without @>
supabase secrets set OPERATOR_TELEGRAM_CHAT_ID=<your chat id>

# NWS automation (api.weather.gov requires a descriptive User-Agent — include contact email)
supabase secrets set NWS_USER_AGENT="MidSouthWX (your@email)"

# Deploy Edge Functions
supabase functions deploy signup --no-verify-jwt
supabase functions deploy telegram-webhook --no-verify-jwt
supabase functions deploy telegram-send-worker
supabase functions deploy scheduled-dispatcher
supabase functions deploy nws-poll
supabase functions deploy nws-dispatcher

# After db push, pg_cron jobs for send-worker + scheduled-dispatcher + nws-poll + nws-dispatcher are created by migrations
# (URLs use project ref in SQL — update migrations if you change projects).

# Register the Telegram webhook
TOKEN="<your bot token>"
SECRET="<same value you set as TELEGRAM_WEBHOOK_SECRET>"
PROJECT_REF="<your project ref>"
curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -d "url=https://${PROJECT_REF}.supabase.co/functions/v1/telegram-webhook" \
  -d "secret_token=${SECRET}"

# Schedule the send worker (run in Supabase SQL Editor)
# Replace <PROJECT_REF> and <CRON_JWT>; create CRON_JWT in Vault first.
# See PLAN.md §3.7 for the snippet.

# Frontend env
cp .env.local.example .env.local
# Fill in the three Supabase values + Turnstile site key + bot username.
# For production invites, set NEXT_PUBLIC_SITE_URL to your public origin (e.g. https://your-app.vercel.app).

npm run dev   # http://localhost:3000
```

### Hi-Res radar renderer (Fly.io)

On-demand NEXRAD Level II overlays (Hi-Res toggle on `/radar`) are rendered by a
separate Python service in the sibling repo
[`../midsouthwx-radar-renderer`](../midsouthwx-radar-renderer). The Next.js app
proxies through `/api/radar/level2/[site]` so the Fly URL and bearer token stay
server-side.

1. Sign up at [fly.io](https://fly.io) and `fly auth login`.
2. Deploy the renderer (see that repo’s README): `fly deploy` from
   `midsouthwx-radar-renderer/`, with secrets `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, and `RENDERER_TOKEN`.
3. Add to `.env.local` (and Vercel production env):

   ```
   RENDERER_BASE_URL=https://midsouthwx-radar.fly.dev
   RENDERER_TOKEN=<same 64-char hex as Fly secret>
   ```

4. Apply migration `20260520010000_radar_tiles_bucket.sql` so Supabase Storage
   has the public `radar-tiles` bucket.

### Auth URLs + operator invites

1. In Supabase **Authentication → URL Configuration**, add redirect URLs your users will hit after email links, including **`https://<your-host>/auth/callback`** (and `http://localhost:3000/auth/callback` for local magic links / invites).
2. Keep **Email** auth enabled; dashboard **Invite operator** uses the Admin API **`inviteUserByEmail`** (requires `SUPABASE_SERVICE_ROLE_KEY` on the Next server). Invited users complete the link flow and are upserted into **`public.operators`** in [`app/auth/callback/route.ts`](app/auth/callback/route.ts).
3. Middleware only requires a valid session to reach `/dashboard`; operator-specific access to subscriber/message data still flows through **`is_operator()`** and RLS.

## What works in v1

- Operator magic-link sign-in (`/login`), with auto-enrollment into `public.operators` on first sign-in (requires insert-self RLS policy from latest migrations).
- **Invite operator** from **`/dashboard`**: sends a Supabase invite email to add another operator (trusted team model).
- Public signup form (`/signup`) → Edge Function validates + geocodes ZIP → returns Telegram deep link.
- Telegram bot `/start <link_token>` claims the pending subscriber.
- Send-worker drains `outbound_queue` at ≤25 msg/s with retry/backoff.
- **Scheduled alerts** (`/schedule`): recurring or one-shot; `scheduled-dispatcher` enqueues the same pipeline as compose.
- **NWS automation** (`/nws`): national active-alert poll (`nws-poll`), rule-based dispatch (`nws-dispatcher`), approve/reject for `pending_approval` NWS messages. Set secret **`NWS_USER_AGENT`**. Region geometry for Mid-South routing: see `scripts/regions-backfill.md`.
- Inbound replies + callback queries land in `replies` / `check_in_responses`.
- Distress-keyword detection DMs the operator via Telegram self-notify.

What's stubbed (lands in a future code drop):
- External integration webhooks (`integration_endpoints` schema exists; `lib/integrations/notify.ts` is a console-log stub).
- Web Push (minimal service worker only — Telegram self-notify is primary).
- `/map` subscriber-distribution heatmap.
- Audit log CSV export and template `{{variable}}` substitution in `/compose`.
- Telegram approve/skip for non-NWS scheduled alerts inside `send_window_minutes`.

## Repo layout

```
app/                Next.js App Router
lib/supabase/       SSR + browser clients
middleware.ts       Auth gate for /(dash) routes
supabase/
  config.toml
  migrations/       0001–0006 — schema + RLS + helper RPCs
  seed.sql          starter templates
  functions/
    signup/                 public signup endpoint (`_shared/` supabase helpers)
    telegram-webhook/       inbound Telegram updates (`_shared/`)
    telegram-send-worker/   outbound queue drain (`_shared/`)
PLAN.md             architecture, schema rationale, milestones
```
