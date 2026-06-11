// Job harness. Each ported Edge Function becomes a Job: same handler
// signature (Request → Response), invoked by the scheduler in main.ts
// instead of by pg_cron → pg_net → HTTPS.
//
// Health telemetry is preserved: every run writes a row to
// public.function_runs via the log_function_run RPC, exactly like the old
// withHealthLog wrapper, so the /health dashboard and the health-monitor job
// keep working unchanged.
import { env } from './env.ts';

export type JobHandler = (req: Request) => Promise<Response>;

export type Job = {
  name: string;
  handler: JobHandler;
};

export function defineJob(name: string, handler: JobHandler): Job {
  return { name, handler };
}

export type RunOutcome = {
  ok: boolean;
  status: number;
  body: unknown;
  durationMs: number;
};

/** Synthesize the request a pg_cron tick used to send. Handlers that check
 *  CRON_INVOKER_JWT keep working because we attach the Bearer header when the
 *  secret is present in the worker's environment. */
function syntheticRequest(job: Job): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const cronJwt = env('CRON_INVOKER_JWT');
  if (cronJwt) headers['authorization'] = `Bearer ${cronJwt}`;
  return new Request(`http://worker.internal/jobs/${job.name}`, {
    method: 'POST',
    headers,
    body: '{}',
  });
}

export async function runJob(job: Job): Promise<RunOutcome> {
  const start = performance.now();
  let ok = true;
  let status = 0;
  let result: unknown = null;
  let errorMsg: string | null = null;
  try {
    const response = await job.handler(syntheticRequest(job));
    status = response.status;
    try {
      const body = (await response.clone().json()) as Record<string, unknown> | null;
      if (body && typeof body.ok === 'boolean') ok = body.ok;
      else ok = response.ok;
      const s = JSON.stringify(body);
      result =
        s.length > 1000 ? { _truncated: true, _len: s.length, _preview: s.slice(0, 400) } : body;
    } catch {
      ok = response.ok;
    }
  } catch (e) {
    ok = false;
    status = 0;
    errorMsg = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Math.round(performance.now() - start);
  await logFunctionRun(job.name, ok, durationMs, result, errorMsg);
  if (!ok) {
    console.error(`[${job.name}] run failed (status ${status})`, errorMsg ?? result);
  }
  return { ok, status, body: result, durationMs };
}

/** Same telemetry write the Edge withHealthLog wrapper performed. Failures
 *  are swallowed — telemetry must never take a job down. */
async function logFunctionRun(
  name: string,
  ok: boolean,
  durationMs: number,
  result: unknown,
  errorMsg: string | null,
): Promise<void> {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/rpc/log_function_run`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_name: name,
      p_ok: ok,
      p_duration_ms: durationMs,
      p_result: result,
      p_error: errorMsg,
    }),
  }).catch(() => {/* swallow */});
}
