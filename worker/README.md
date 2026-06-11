# midsouthwx worker

A single supervised Node process that runs the 14 polling/dispatch jobs
previously orchestrated as pg_cron → `pg_net.http_post` → individual Supabase
Edge Functions. One process, one shared `lib/`, an internal scheduler, and an
HTTP `/healthz` endpoint — no per-minute HTTP hops, no per-function copies of
`_shared/`, and no self-reinvocation tricks to beat the 1-minute cron floor.

`telegram-webhook` and `signup` are **not** here: they are public HTTPS
endpoints, not scheduled jobs, and stay as Edge Functions.

## What changed vs. the Edge Functions

- Handler logic is ported **verbatim** by `scripts/port-edge-to-worker.mjs`
  (run it again to re-sync if the Edge sources change during the transition).
  Only the runtime shell differs: npm imports instead of `jsr:`/`esm.sh`,
  `env()` instead of `Deno.env.get()`, `defineJob()` instead of
  `Deno.serve(withHealthLog(...))`.
- `telegram-send-worker` runs as a **drain loop**: back-to-back while the
  outbound queue has work, 3s idle sleep when empty. Median alert latency
  drops from "up to 60s" to single-digit seconds.
- `nws-poll` runs at an honest 30s interval; the Edge version's self-scheduled
  follow-up poll (a workaround for the 1-minute cron floor) is removed.
- Health telemetry is unchanged: every run still writes `function_runs` via
  the `log_function_run` RPC, so the `/health` dashboard and the
  health-monitor job work exactly as before.
- Jobs still honor `CRON_INVOKER_JWT` if set (the scheduler attaches the
  Bearer header to its synthetic requests).

## Local

```bash
cd worker
npm install
npm run typecheck
npm run validate    # prints the job registry
npm start           # needs the env vars below
```

## Environment

Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
`NWS_USER_AGENT`.

Per-feature (same secrets the Edge Functions used): `DEEPSEEK_API_KEY`
(AI summaries), `RENDERER_BASE_URL` + `RENDERER_TOKEN` (couplet scan),
`OPERATOR_TELEGRAM_CHAT_ID`, `PUBLIC_SITE_URL`, `TELEGRAM_BOT_USERNAME`,
`CRON_INVOKER_JWT`, `INTERNAL_API_TOKEN`, plus the feature flags
(`CAP_DISPATCHER_ENABLED`, `COUPLET_DISPATCHER_LIVE`, `COUPLET_POLL_FORCE`,
`NWS_DISPATCHER_DISABLED`, `LIBREWXR_ALERT_BBOX`).

## Deploy (Fly.io)

```bash
cd worker
fly launch --no-deploy        # first time only
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  TELEGRAM_BOT_TOKEN=... NWS_USER_AGENT=... ...
fly deploy
fly logs                      # watch the jobs tick
curl https://<app>.fly.dev/healthz | jq .
```

Run exactly **one** machine (`min_machines_running = 1`, no autoscaling). A
brief two-instance overlap during deploys is safe — every claim path uses
`FOR UPDATE SKIP LOCKED` and the poll upserts are idempotent — but steady-state
should be a singleton.

## Cutover

1. Deploy the worker; confirm `/healthz` shows runs accumulating and
   `/health` in the dashboard shows fresh `function_runs` rows.
2. Expect doubled polling briefly: pg_cron and the worker are both running.
   This is safe (locks + idempotent upserts) but don't linger.
3. Run `worker/cutover.sql` in the Supabase SQL editor to unschedule the 14
   HTTP-invoker cron jobs. Pure-SQL maintenance jobs (prunes/sweeps) stay on
   pg_cron.
4. Keep the Edge Functions deployed for now — they are the rollback target.
   Decommission them once the worker has ridden out a real weather day.

Rollback: `worker/rollback.sql` restores all 14 cron schedules, then scale the
worker to zero (`fly scale count 0`).
