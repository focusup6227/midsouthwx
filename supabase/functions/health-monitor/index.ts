// health-monitor — periodic regression detector.
//
// Runs every 5 min via pg_cron. For each cron-driven Edge Function we care
// about, checks two conditions over a trailing window:
//   1. failure_spike — ≥3 failures AND ≥50% failure rate in the last 15 min
//   2. stale         — last_fired_at older than expected cadence × 5
//
// On a new issue (no debounce row, or debounce expired), DMs the operator
// once with a compact summary. When an issue clears, sends a one-shot
// "resolved" DM and deletes the debounce row. Otherwise silent — operator
// only hears about changes.
//
// Reads from function_runs directly so we don't need to extend the existing
// function_health() RPC (which is 24h-scoped for the dashboard view).

import { serviceClient, json, withHealthLog } from './supabase.ts';

// Functions we expect to fire on a cron cadence (minutes between expected
// runs). Anything not listed is on-demand and never checked for staleness.
// Failure-spike check runs against every function that DID fire in the
// window — no separate list needed.
const EXPECTED_CADENCE_MIN: Record<string, number> = {
  'nws-poll': 1,
  'nws-dispatcher': 1,
  'telegram-send-worker': 1,
  'scheduled-dispatcher': 1,
  'librewxr-poll': 1,
  'event-recap': 5,
  'lsr-poll': 5,
  'spc-poll': 30,
  'afd-poll': 30,
};

const WINDOW_MIN = 15;
const FAILURE_MIN_COUNT = 3;
const FAILURE_RATE_THRESHOLD = 0.5;
const STALENESS_MULTIPLIER = 5;
const DEBOUNCE_MIN = 30;

type FunctionRunSlim = {
  function_name: string;
  fired_at: string;
  ok: boolean;
  error: string | null;
};

type Issue = {
  function_name: string;
  condition: 'failure_spike' | 'stale';
  summary: string;
};

type AlertRow = {
  function_name: string;
  condition: string;
  last_alerted_at: string;
};

function detectIssues(
  rows: FunctionRunSlim[],
  now: Date,
): Issue[] {
  const issues: Issue[] = [];

  // Group runs by function.
  const byFn = new Map<string, FunctionRunSlim[]>();
  for (const r of rows) {
    const arr = byFn.get(r.function_name) ?? [];
    arr.push(r);
    byFn.set(r.function_name, arr);
  }

  // 1. Failure-spike across any function with runs in the window.
  for (const [fn, runs] of byFn) {
    const fails = runs.filter((r) => !r.ok);
    if (fails.length < FAILURE_MIN_COUNT) continue;
    const rate = fails.length / runs.length;
    if (rate < FAILURE_RATE_THRESHOLD) continue;
    const latestErr = fails
      .map((f) => f.error)
      .filter((e): e is string => Boolean(e))
      .at(-1);
    issues.push({
      function_name: fn,
      condition: 'failure_spike',
      summary: `${fails.length}/${runs.length} runs failed in ${WINDOW_MIN}m${latestErr ? ` · ${latestErr.slice(0, 120)}` : ''}`,
    });
  }

  // 2. Staleness for cron-driven functions. Window-scoped runs may be empty
  // for any function, so we use the LAST seen run from the window as the
  // baseline — if even the window has zero runs, the function is stale by
  // definition (> WINDOW_MIN minutes since last fired).
  for (const [fn, cadenceMin] of Object.entries(EXPECTED_CADENCE_MIN)) {
    const threshold = cadenceMin * STALENESS_MULTIPLIER;
    const runs = byFn.get(fn) ?? [];
    if (runs.length > 0) {
      const lastFired = runs
        .map((r) => new Date(r.fired_at).getTime())
        .reduce((a, b) => Math.max(a, b), 0);
      const ageMin = (now.getTime() - lastFired) / 60_000;
      if (ageMin > threshold) {
        issues.push({
          function_name: fn,
          condition: 'stale',
          summary: `no runs in ${Math.round(ageMin)}m (expected ~${cadenceMin}m cadence)`,
        });
      }
    } else if (WINDOW_MIN > threshold) {
      // Window itself exceeds the stale threshold and showed nothing.
      issues.push({
        function_name: fn,
        condition: 'stale',
        summary: `no runs in ${WINDOW_MIN}m+ (expected ~${cadenceMin}m cadence)`,
      });
    }
  }

  return issues;
}

function formatTelegramAlert(issues: Issue[]): string {
  if (issues.length === 0) return '';
  const lines = ['🔴 Health alert\n'];
  for (const i of issues) {
    const icon = i.condition === 'stale' ? '⏸' : '⚠️';
    lines.push(`${icon} <b>${i.function_name}</b> — ${i.summary}`);
  }
  lines.push('\nSee /health for details.');
  return lines.join('\n');
}

function formatResolved(cleared: AlertRow[]): string {
  if (cleared.length === 0) return '';
  const lines = ['🟢 Health resolved\n'];
  for (const c of cleared) {
    lines.push(`✓ <b>${c.function_name}</b> — ${c.condition} cleared`);
  }
  return lines.join('\n');
}

async function sendTelegram(token: string, chatId: number, text: string): Promise<boolean> {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  return r.ok;
}

Deno.serve(withHealthLog('health-monitor', async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false }, 405);

  const cronJwt = Deno.env.get('CRON_INVOKER_JWT');
  if (cronJwt) {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${cronJwt}`) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const supa = serviceClient();
  const now = new Date();
  const windowStartIso = new Date(now.getTime() - WINDOW_MIN * 60_000).toISOString();

  const { data: runs, error: runsErr } = await supa
    .from('function_runs')
    .select('function_name, fired_at, ok, error')
    .gte('fired_at', windowStartIso)
    .neq('function_name', 'health-monitor')  // don't alert on ourselves
    .order('fired_at', { ascending: true });
  if (runsErr) return json({ ok: false, error: runsErr.message }, 500);

  const issues = detectIssues((runs ?? []) as FunctionRunSlim[], now);

  const { data: existing, error: alertsErr } = await supa
    .from('health_alerts')
    .select('function_name, condition, last_alerted_at');
  if (alertsErr) return json({ ok: false, error: alertsErr.message }, 500);

  const existingKeys = new Map(
    (existing ?? []).map((a) => [`${a.function_name}|${a.condition}`, a as AlertRow]),
  );
  const currentKeys = new Set(issues.map((i) => `${i.function_name}|${i.condition}`));

  // Issues to alert: new, OR existing with debounce expired.
  const debounceCutoff = new Date(now.getTime() - DEBOUNCE_MIN * 60_000).getTime();
  const toAlert = issues.filter((i) => {
    const key = `${i.function_name}|${i.condition}`;
    const prev = existingKeys.get(key);
    if (!prev) return true;
    return new Date(prev.last_alerted_at).getTime() < debounceCutoff;
  });

  // Cleared: existing rows whose key isn't in current issues.
  const cleared = [...existingKeys.values()].filter(
    (a) => !currentKeys.has(`${a.function_name}|${a.condition}`),
  );

  const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Number(Deno.env.get('OPERATOR_TELEGRAM_CHAT_ID') ?? 0);

  let alerted = 0;
  let resolvedCount = 0;

  if (tgToken && chatId) {
    if (toAlert.length > 0) {
      const ok = await sendTelegram(tgToken, chatId, formatTelegramAlert(toAlert));
      if (ok) alerted = toAlert.length;
    }
    if (cleared.length > 0) {
      const ok = await sendTelegram(tgToken, chatId, formatResolved(cleared));
      if (ok) resolvedCount = cleared.length;
    }
  }

  // Upsert alerted issues so the next tick respects the debounce window.
  if (toAlert.length > 0) {
    await supa.from('health_alerts').upsert(
      toAlert.map((i) => ({
        function_name: i.function_name,
        condition: i.condition,
        last_alerted_at: now.toISOString(),
        last_summary: i.summary,
      })),
      { onConflict: 'function_name,condition' },
    );
  }
  // Delete cleared rows so a future recurrence triggers a fresh DM.
  if (cleared.length > 0) {
    // PostgREST's composite-PK delete is awkward; do per-row deletes.
    await Promise.all(
      cleared.map((c) =>
        supa
          .from('health_alerts')
          .delete()
          .eq('function_name', c.function_name)
          .eq('condition', c.condition),
      ),
    );
  }

  return json({
    ok: true,
    window_min: WINDOW_MIN,
    runs_scanned: runs?.length ?? 0,
    issues: issues.length,
    alerted,
    resolved: resolvedCount,
  });
}));
