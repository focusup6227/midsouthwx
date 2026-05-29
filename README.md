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

# Supabase CLI — pick one:
#   A) From the repo (no Homebrew): npm install  then  npx supabase login
#   B) Homebrew: brew install supabase/tap/supabase
#   C) https://supabase.com/docs/guides/cli

npx supabase login
npx supabase link --project-ref <YOUR_PROJECT_REF>

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

# Register /help, /prefs, etc. in Telegram's command menu (☰ next to the message box)
npm run telegram:commands
# Or after deploy: curl -X POST "https://${PROJECT_REF}.supabase.co/functions/v1/telegram-webhook?setup_commands=1" \
#   -H "X-Telegram-Bot-Api-Secret-Token: ${SECRET}"

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

### Branded auth emails + production SMTP

The operator-invite and magic-link emails are dark-branded HTML templates in [`supabase/templates/`](supabase/templates/). `supabase/config.toml` wires them via `content_path` for the **local** stack only — production is configured in the dashboard. To set up production (one-time):

1. **Site URL** — Supabase **Authentication → URL Configuration → Site URL** = `https://midsouthwx.app`. The templates embed the logo via `{{ .SiteURL }}/icons/icon-192.png`, so a wrong/localhost Site URL breaks the logo.
2. **Redirect allowlist** — add `https://midsouthwx.app/auth/callback`, a Vercel preview wildcard, and `http://localhost:3000/auth/callback`. (Mirrored in `config.toml`'s `additional_redirect_urls` for the local stack.)
3. **Templates** — paste `supabase/templates/invite.html` and `magic_link.html` into **Authentication → Emails** (Invite user / Magic Link), with subjects `You're invited to operate Mid-South WX` and `Mid-South WX — your sign-in link`.
4. **Custom SMTP** — Supabase's built-in email is rate-limited and not for production. **Authentication → Emails → SMTP Settings → Enable Custom SMTP**, pointed at Resend (`midsouthwx.app` is the verified sender domain):
   | Field | Value |
   |-------|-------|
   | Host / Port | `smtp.resend.com` / `465` |
   | Username | `resend` |
   | Password | a Resend API key (`re_…`) |
   | Sender | `MidSouthWX <invites@midsouthwx.app>` |

   Then raise **Authentication → Rate Limits → emails per hour** above the tiny default.
5. **`NEXT_PUBLIC_SITE_URL`** — set to `https://midsouthwx.app` in **Vercel** (Production). Drives the subscriber-invite logo, forecast share URLs, `{{url}}` in compose, and the operator-invite redirect fallback.

> Do **not** `supabase config push` — `config.toml`'s `site_url` is localhost for local dev and would overwrite the production Site URL. Production auth/email config lives in the dashboard.

The subscriber-invite email ([`app/subscribers/invite/actions.ts`](app/subscribers/invite/actions.ts)) is sent by the app via Resend's HTTP API (`RESEND_API_KEY` + `EMAIL_FROM`), independent of Supabase SMTP.

## What works in v1

- Operator magic-link sign-in (`/login`), with auto-enrollment into `public.operators` on first sign-in (requires insert-self RLS policy from latest migrations).
- **Invite operator** from **`/dashboard`**: sends a Supabase invite email to add another operator (trusted team model).
- Public signup form (`/signup`) → Edge Function validates + geocodes ZIP → returns Telegram deep link.
- Telegram bot `/start <link_token>` claims the pending subscriber.
- Send-worker drains `outbound_queue` at ≤25 msg/s with retry/backoff.
- **Scheduled alerts** (`/schedule`): recurring or one-shot; `scheduled-dispatcher` enqueues the same pipeline as compose.
- **NWS automation** (`/nws`): national active-alert poll (`nws-poll`), rule-based dispatch (`nws-dispatcher`), approve/reject for `pending_approval` NWS messages. Set secret **`NWS_USER_AGENT`**. Region geometry for Mid-South routing: see `scripts/regions-backfill.md`.
- Inbound replies + callback queries land in `replies` / `check_in_responses`.
- **Inbox thread replies:** reply to a subscriber from `/inbox/[conversation_id]` (Telegram DM + outbound row in the thread). Requires migration `20260529000001_inbox_outbound_replies.sql` and `TELEGRAM_BOT_TOKEN` on the Next server.
- Distress-keyword detection DMs the operator via Telegram self-notify.

What's stubbed (lands in a future code drop):
- Web Push (minimal service worker only — Telegram self-notify is primary).
- Inbound CAP/partner feed ingest into `nws_alerts`.
- Subscriber alert preferences (quiet hours, per-category opt-out).

Recent operator workflow additions:
- Template editor in Settings; compose fills `{{headline}}`, `{{event}}`, `{{area_desc}}`, `{{expires_at}}`.
- `/map` subscriber heatmap by region.
- Distress keyword tuning (word-boundary matching + expanded list).
- 2-year retention cron + NWS poll follow-up (~2×/min).

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
