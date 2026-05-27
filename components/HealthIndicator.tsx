'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { supabaseBrowser } from '@/lib/supabase/client';

// Continuous header strip showing the freshness of the three signals an
// operator cares about during an event:
//
//   NWS — seconds since the last successful nws-poll run.
//   Worker — seconds since the last successful telegram-send-worker run.
//   Queue — count of pending outbound rows (zero = caught up).
//
// Read via the existing function_health() + outbound_queue_depth() RPCs
// so we don't introduce new permissions. Polls every 15 s when visible;
// updates "ago" labels every second locally so the strip ticks live
// without hammering the database.

type HealthRow = {
  function_name: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  failures_24h: number;
};

type QueueRow = {
  status: string;
  count: number;
};

async function fetchHealth() {
  const supa = supabaseBrowser();
  const [{ data: fh }, { data: qd }] = await Promise.all([
    supa.rpc('function_health'),
    supa.rpc('outbound_queue_depth'),
  ]);
  return {
    health: (fh ?? []) as HealthRow[],
    queue: (qd ?? []) as QueueRow[],
  };
}

function ageSeconds(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

function fmtAge(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

// Color tone based on staleness. The thresholds are tuned to the cron
// cadence: send-worker fires every minute, nws-poll runs twice a minute,
// so anything ≥3 minutes is suspicious and ≥10 minutes is broken.
function tone(seconds: number | null, kind: 'recent' | 'stale'): string {
  if (seconds == null) return 'text-wx-mute';
  if (kind === 'recent') {
    if (seconds < 180) return 'text-wx-ok';
    if (seconds < 600) return 'text-amber-400';
    return 'text-wx-danger';
  }
  // queue depth path uses absolute thresholds, handled by caller
  return 'text-wx-mute';
}

export default function HealthIndicator() {
  const { data } = useSWR('health-indicator', fetchHealth, {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
  });
  // Local re-render every second so the "Ns ago" labels tick smoothly
  // between SWR fetches. Cheap because the underlying data doesn't change.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const nwsPoll = data?.health.find((h) => h.function_name === 'nws-poll');
  const worker = data?.health.find((h) => h.function_name === 'telegram-send-worker');
  const queuePending = data?.queue.find((q) => q.status === 'pending')?.count ?? 0;

  const nwsAge = ageSeconds(nwsPoll?.last_success_at ?? null);
  const workerAge = ageSeconds(worker?.last_success_at ?? null);

  const queueTone =
    queuePending === 0
      ? 'text-wx-ok'
      : queuePending < 50
        ? 'text-wx-fg'
        : queuePending < 250
          ? 'text-amber-400'
          : 'text-wx-danger';

  return (
    <Link
      href="/health"
      className="hidden items-center gap-2 rounded border border-wx-line bg-wx-bg/40 px-2 py-1 text-[11px] font-mono hover:bg-wx-line/30 lg:flex"
      title="Live system health · click for details"
    >
      <span className="text-wx-mute">NWS</span>
      <span className={tone(nwsAge, 'recent')}>{fmtAge(nwsAge)}</span>
      <span className="text-wx-line">·</span>
      <span className="text-wx-mute">Worker</span>
      <span className={tone(workerAge, 'recent')}>{fmtAge(workerAge)}</span>
      <span className="text-wx-line">·</span>
      <span className="text-wx-mute">Queue</span>
      <span className={queueTone}>{queuePending}</span>
    </Link>
  );
}
