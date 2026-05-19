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

# Deploy Edge Functions
supabase functions deploy signup --no-verify-jwt
supabase functions deploy telegram-webhook --no-verify-jwt
supabase functions deploy telegram-send-worker

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

npm run dev   # http://localhost:3000
```

## What works in v1

- Operator magic-link sign-in (`/login`), with auto-enrollment into `public.operators` on first sign-in.
- Public signup form (`/signup`) → Edge Function validates + geocodes ZIP → returns Telegram deep link.
- Telegram bot `/start <link_token>` claims the pending subscriber.
- Send-worker drains `outbound_queue` at ≤25 msg/s with retry/backoff.
- Inbound replies + callback queries land in `replies` / `check_in_responses`.
- Distress-keyword detection DMs the operator via Telegram self-notify.

What's stubbed (lands in next code drop):
- `/compose`, `/inbox`, `/subscribers`, `/groups`, `/settings`, `/map` pages.
- Realtime hooks in the dashboard (Supabase publication is already configured in 0005).
- PWA service worker + Web Push (Telegram self-notify is the v1 primary).

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
