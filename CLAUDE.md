# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-operator severe weather alert dashboard. Next.js 14 App Router PWA on Vercel, Supabase (Postgres + PostGIS + pg_cron + Edge Functions) backend, Telegram DMs as the sole delivery channel. `PLAN.md` is the authoritative architecture/spec doc — read it before substantive changes to schema, edge functions, or audience resolution. Locked decisions live in `PLAN.md` §0.

## Commands

```bash
npm run dev          # Next.js dev server on :3000
npm run build        # production build
npm run lint         # next lint
npm run typecheck    # tsc --noEmit (excludes supabase/functions; Edge Functions are Deno)

npm run db:push      # apply migrations to the linked Supabase project
npm run db:diff      # diff local schema vs remote
npm run db:reset     # WIPES local db + reapplies migrations + seed

npm run fn:deploy <name>   # deploy a single Edge Function (signup | telegram-webhook | telegram-send-worker)
npm run fn:serve           # serve Edge Functions locally

# One-off scripts (read .env.local for SUPABASE_URL + SERVICE_ROLE_KEY)
node scripts/set-operator-password.mjs <new-password> [email]
node scripts/gen-icons.mjs
```

There is no test suite. Verify changes by exercising the dev server and the deployed Edge Functions directly.

## Architecture

### Frontend layering (Next.js 14 App Router)

- `app/` — flat route layout (no `(dash)` group despite what PLAN.md draft shows). Auth gating is centralized in `middleware.ts`: every path except `/login`, `/signup`, `/auth/*`, `/` and static assets requires a Supabase session, else redirects to `/login?next=...`.
- Three Supabase client factories — pick the right one (browser/server clients use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` if set, else `NEXT_PUBLIC_SUPABASE_ANON_KEY` — see `lib/supabase/env.ts`):
  - `lib/supabase/server.ts` → `supabaseServer()` — RLS-respecting SSR client for Server Components, Route Handlers, server actions. Uses cookie store. Handles the "can't set cookies from a Server Component" case silently (middleware refreshes on the next request).
  - `lib/supabase/server.ts` → `supabaseAdmin()` — service-role client. **Only** for server actions/route handlers that genuinely need to bypass RLS (e.g., admin tasks). Never expose to a client component.
  - `lib/supabase/client.ts` → `supabaseBrowser()` — for `'use client'` components and Realtime subscriptions.
- `middleware.ts` also runs `getUser()` on every request — that doubles as the session-refresh path. If you add new public routes, extend the `isPublic` allowlist.

### Backend layering (Supabase)

- **Migrations** (`supabase/migrations/`) are timestamp-prefixed (`YYYYMMDDhhmmss_name.sql`); they apply in lexical order. The first seven mirror PLAN.md §3 (extensions → subscribers → groups+audience → messaging → inbox → worker helpers → cron). `0008` adds signup throttling, `20260519000001_address.sql` extends subscribers with home address.
- **RLS pattern is uniform**: every `public.*` table is operator-only via `public.is_operator()` (`select 1 from public.operators where user_id = auth.uid()`). The `anon`/`authenticated` roles get **no** grants on subscriber/reply/message tables. The only public surface is the `signup` Edge Function, which runs as service_role.
- **Edge Functions** (`supabase/functions/`, Deno, excluded from tsconfig):
  - `signup` — public HTTPS, rate-limited via `signup_attempts` table, validates input, geocodes ZIP, creates pending subscriber + `link_token`, returns the `t.me/<bot>?start=<token>` URL.
  - `telegram-webhook` — verifies `X-Telegram-Bot-Api-Secret-Token` header, routes `/start <token>`, location updates, replies, callback queries; writes `replies` + `check_in_responses`; self-notifies operator on distress keywords.
  - `telegram-send-worker` — pg_cron-invoked, drains `outbound_queue` with `for update skip locked` at ≤25 msg/s, retries 5xx/429 (respects `retry_after`), updates `delivery_logs`. Self-reinvokes within a single cron tick to exceed the 1-minute floor.
  - Shared helpers are duplicated under each function’s `_shared/` (`serviceClient()`, `json()`, Telegram helpers) so deploy bundles resolve `./_shared/*.ts` (parent-folder imports are omitted from the upload).
- **Audience resolution** is a single SQL function `public.resolve_audience(spec jsonb)` called from both the compose preview and the queue-insertion server action. **Never re-implement audience logic in TS** — the design guarantees preview-count = queued-count.
- **Cron** lives in migration `..._cron.sql`. Schedules invoke Edge Functions via `pg_net.http_post` using a `cron_invoker_jwt` stored in Vault.

### Outbound message lifecycle

`messages` (status: `draft`→`queued`/`pending_approval`→`sending`→`sent`) → fan out into `outbound_queue` (one row per `(message_id, subscriber_id)`, deduped by unique index) → `telegram-send-worker` claims pending rows → writes `delivery_logs` events. Realtime is enabled on `replies`, `delivery_logs`, `outbound_queue` for live dashboard updates.

## Conventions worth knowing

- `@/*` path alias → repo root (e.g., `@/lib/supabase/server`).
- Migration filenames use the timestamp prefix `YYYYMMDDhhmmss_` — match the existing style when creating new ones (`supabase migration new <name>` does this for you).
- Edge Functions import from `jsr:@supabase/supabase-js@2` (Deno-style), not `@supabase/supabase-js` — don't paste Edge code into the Next app or vice versa.
- The Supabase config (`supabase/config.toml`) sets `verify_jwt = false` on all three Edge Functions; they each enforce their own auth (HMAC for the webhook, cron JWT for the worker, rate-limit + Turnstile for signup).
- Auth is currently magic-link + password (see `app/auth/callback`, `scripts/set-operator-password.mjs`); operator self-enrolls into `public.operators` on first sign-in.
- Telegram has no read receipts for bots — "delivered" = 200 from `sendMessage`. Don't promise "read" in UI copy.
