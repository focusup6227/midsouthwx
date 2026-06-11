// midsouthwx worker — single supervised process replacing the pg_cron →
// pg_net → Edge Function orchestration for the polling/dispatch jobs.
//
// Three schedule kinds:
//   interval — run every N seconds (skips a tick if the previous run is
//              still in flight, matching pg_cron's behavior)
//   drain    — run back-to-back while there is work (the send loop); sleep
//              briefly when the queue is empty. This natively fixes the
//              1-minute cron floor the Edge send-worker worked around by
//              self-reinvoking.
//   dailyUtc — run once a day at a fixed UTC time (daily-forecast)
//
// telegram-webhook and signup remain Edge Functions: they are public HTTPS
// endpoints, not scheduled jobs.
import { createServer } from 'node:http';
import { runJob, type Job, type RunOutcome } from './lib/harness.ts';
import { env } from './lib/env.ts';

import afdPoll from './jobs/afd-poll/index.ts';
import capDispatcher from './jobs/cap-dispatcher/index.ts';
import coupletDispatcher from './jobs/couplet-dispatcher/index.ts';
import coupletPoll from './jobs/couplet-poll/index.ts';
import dailyForecast from './jobs/daily-forecast/index.ts';
import eventRecap from './jobs/event-recap/index.ts';
import healthMonitor from './jobs/health-monitor/index.ts';
import librewxrPoll from './jobs/librewxr-poll/index.ts';
import lsrPoll from './jobs/lsr-poll/index.ts';
import nwsDispatcher from './jobs/nws-dispatcher/index.ts';
import nwsPoll from './jobs/nws-poll/index.ts';
import scheduledDispatcher from './jobs/scheduled-dispatcher/index.ts';
import spcPoll from './jobs/spc-poll/index.ts';
import sendWorker from './jobs/telegram-send-worker/index.ts';

type Schedule =
  | { kind: 'interval'; everySec: number }
  | { kind: 'drain'; idleDelaySec: number }
  | { kind: 'dailyUtc'; hour: number; minute: number };

// Cadences mirror the pg_cron schedules they replace (see worker/cutover.sql),
// except nws-poll: the cron job ran 1/min and self-scheduled a +30s follow-up
// for an effective 2×/min — here it is simply an honest 30s interval.
const REGISTRY: { job: Job; schedule: Schedule }[] = [
  { job: sendWorker, schedule: { kind: 'drain', idleDelaySec: 3 } },
  { job: nwsPoll, schedule: { kind: 'interval', everySec: 30 } },
  { job: nwsDispatcher, schedule: { kind: 'interval', everySec: 60 } },
  { job: scheduledDispatcher, schedule: { kind: 'interval', everySec: 60 } },
  { job: librewxrPoll, schedule: { kind: 'interval', everySec: 60 } },
  { job: capDispatcher, schedule: { kind: 'interval', everySec: 60 } },
  { job: coupletPoll, schedule: { kind: 'interval', everySec: 60 } },
  { job: coupletDispatcher, schedule: { kind: 'interval', everySec: 60 } },
  { job: lsrPoll, schedule: { kind: 'interval', everySec: 300 } },
  { job: healthMonitor, schedule: { kind: 'interval', everySec: 300 } },
  { job: eventRecap, schedule: { kind: 'interval', everySec: 300 } },
  { job: spcPoll, schedule: { kind: 'interval', everySec: 1800 } },
  { job: afdPoll, schedule: { kind: 'interval', everySec: 1800 } },
  { job: dailyForecast, schedule: { kind: 'dailyUtc', hour: 12, minute: 15 } },
];

type JobStats = {
  runs: number;
  failures: number;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastDurationMs: number | null;
};

const stats = new Map<string, JobStats>(
  REGISTRY.map(({ job }) => [
    job.name,
    { runs: 0, failures: 0, lastRunAt: null, lastOk: null, lastDurationMs: null },
  ]),
);

let shuttingDown = false;
let inFlight = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runTracked(job: Job): Promise<RunOutcome> {
  inFlight++;
  try {
    const outcome = await runJob(job);
    const s = stats.get(job.name)!;
    s.runs++;
    if (!outcome.ok) s.failures++;
    s.lastRunAt = new Date().toISOString();
    s.lastOk = outcome.ok;
    s.lastDurationMs = outcome.durationMs;
    return outcome;
  } finally {
    inFlight--;
  }
}

async function intervalLoop(job: Job, everySec: number, startDelayMs: number) {
  await sleep(startDelayMs);
  while (!shuttingDown) {
    const started = Date.now();
    await runTracked(job);
    const elapsed = Date.now() - started;
    await sleep(Math.max(everySec * 1000 - elapsed, 1000));
  }
}

async function drainLoop(job: Job, idleDelaySec: number, startDelayMs: number) {
  await sleep(startDelayMs);
  while (!shuttingDown) {
    const outcome = await runTracked(job);
    const body = outcome.body as { claimed?: number } | null;
    const claimed = typeof body?.claimed === 'number' ? body.claimed : 0;
    if (!outcome.ok) {
      await sleep(10_000); // back off on errors; the queue retains the rows
    } else if (claimed === 0) {
      await sleep(idleDelaySec * 1000);
    }
    // claimed > 0 and ok: loop immediately — there may be more queued work.
  }
}

async function dailyUtcLoop(job: Job, hour: number, minute: number) {
  while (!shuttingDown) {
    const now = new Date();
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0),
    );
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    // Sleep in ≤60s slices so shutdown isn't blocked behind a 20-hour timer.
    while (!shuttingDown && Date.now() < next.getTime()) {
      await sleep(Math.min(60_000, next.getTime() - Date.now()));
    }
    if (shuttingDown) return;
    await runTracked(job);
  }
}

function startHealthServer() {
  const port = Number(env('PORT') ?? 8080);
  const startedAt = new Date().toISOString();
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      const jobs = Object.fromEntries(stats);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started_at: startedAt, in_flight: inFlight, jobs }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  server.listen(port, () => console.log(`health endpoint on :${port}/healthz`));
  return server;
}

function describeSchedule(s: Schedule): string {
  if (s.kind === 'interval') return `every ${s.everySec}s`;
  if (s.kind === 'drain') return `drain (idle ${s.idleDelaySec}s)`;
  return `daily ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')} UTC`;
}

async function main() {
  if (process.argv.includes('--validate')) {
    for (const { job, schedule } of REGISTRY) {
      console.log(`${job.name.padEnd(22)} ${describeSchedule(schedule)}`);
    }
    return;
  }

  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN', 'NWS_USER_AGENT']) {
    if (!env(name)) {
      console.error(`missing required env: ${name}`);
      process.exit(1);
    }
  }

  const server = startHealthServer();

  const shutdown = async (signal: string) => {
    console.log(`${signal} received; draining (${inFlight} in flight)`);
    shuttingDown = true;
    server.close();
    const deadline = Date.now() + 30_000;
    while (inFlight > 0 && Date.now() < deadline) await sleep(500);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(`starting ${REGISTRY.length} jobs`);
  const loops = REGISTRY.map(({ job, schedule }, i) => {
    // Stagger startup so 14 jobs don't all hit the DB in the same instant.
    const startDelayMs = i * 1500;
    if (schedule.kind === 'interval') return intervalLoop(job, schedule.everySec, startDelayMs);
    if (schedule.kind === 'drain') return drainLoop(job, schedule.idleDelaySec, startDelayMs);
    return dailyUtcLoop(job, schedule.hour, schedule.minute);
  });
  await Promise.all(loops);
}

main().catch((e) => {
  console.error('worker crashed', e);
  process.exit(1);
});
