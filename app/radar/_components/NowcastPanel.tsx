'use client';

// F9 (operator-approval): floating panel on /radar listing actionable couplet
// nowcast candidates (rotation tracks the shadow dispatcher flagged as
// "would have fired"). The operator reviews each and taps Send to DM the
// projected-swath audience an early radar-based heads-up. Stays out of the way
// — collapses to a small pill, and the pill only turns amber when there's
// something to act on. Nothing here auto-fires; every send is one tap.

import { useState, useTransition } from 'react';
import useSWR from 'swr';
import { dispatchNowcast } from '../nowcast-actions';
import type { NowcastCandidate } from '@/app/api/radar/nowcast/route';

const ENDPOINT = '/api/radar/nowcast';

const jsonFetcher = (url: string) => fetch(url).then((r) => r.json());

type Resp = { candidates: NowcastCandidate[]; window_minutes?: number; error?: string };

type SentState = Record<string, { ok: boolean; text: string }>;

function tierLabel(tier: string | null): { text: string; cls: string } {
  switch (tier) {
    case 'PDS_TOR':
      return { text: 'PDS Tornado Watch', cls: 'bg-fuchsia-600/30 text-fuchsia-200 border-fuchsia-500/40' };
    case 'TOR':
      return { text: 'Tornado Watch', cls: 'bg-red-600/30 text-red-200 border-red-500/40' };
    case 'SVR':
      return { text: 'Svr T-Storm Watch', cls: 'bg-amber-600/30 text-amber-200 border-amber-500/40' };
    default:
      return { text: 'No active watch', cls: 'bg-slate-600/30 text-slate-300 border-slate-500/40' };
  }
}

function ageLabel(firedAt: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(firedAt).getTime()) / 60_000));
  return mins <= 0 ? 'just now' : `${mins}m ago`;
}

export default function NowcastPanel() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<SentState>({});
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, mutate } = useSWR<Resp>(ENDPOINT, jsonFetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });

  const candidates = data?.candidates ?? [];
  const count = candidates.length;

  function send(c: NowcastCandidate) {
    setBusyId(c.id);
    startTransition(async () => {
      try {
        const res = await dispatchNowcast({ couplet_alert_id: c.id });
        setSent((s) => ({
          ...s,
          [c.id]: res.ok
            ? { ok: true, text: `Sent to ${res.count} subscriber${res.count === 1 ? '' : 's'}` }
            : { ok: false, text: res.error },
        }));
        if (res.ok) await mutate();
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col items-start gap-2">
      {open && (
        <div className="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-slate-700/70 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <span aria-hidden>🌀</span> Rotation nowcasts
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              Hide
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {count === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-400">
                No actionable rotation right now. Tracks that pass the watch +
                shear gate and have subscribers in their projected path appear
                here for one-tap dispatch.
              </div>
            )}

            {candidates.map((c) => {
              const tier = tierLabel(c.environment_tier);
              const result = sent[c.id];
              const isBusy = busyId === c.id && pending;
              return (
                <div key={c.id} className="border-b border-slate-800/70 px-3 py-2.5 last:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-slate-300">{c.track_id}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tier.cls}`}>
                      {tier.text}
                    </span>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    <span>
                      <span className="text-slate-200">{Math.round(c.shear_kt)}</span> kt shear
                    </span>
                    <span>
                      <span className="text-slate-200">{c.audience_count}</span> in path
                    </span>
                    {c.projection_minutes ? <span>~{c.projection_minutes}m lead</span> : null}
                    <span>{ageLabel(c.fired_at)}</span>
                  </div>

                  {result ? (
                    <div
                      className={`mt-2 rounded px-2 py-1 text-[11px] ${
                        result.ok
                          ? 'bg-emerald-600/20 text-emerald-200'
                          : 'bg-red-600/20 text-red-200'
                      }`}
                    >
                      {result.ok ? '✓ ' : '✕ '}
                      {result.text}
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => send(c)}
                      className="mt-2 w-full rounded-md bg-amber-500 px-2 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isBusy ? 'Sending…' : `Send heads-up to ${c.audience_count}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`pointer-events-auto flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-lg backdrop-blur transition ${
          count > 0
            ? 'animate-pulse border-amber-400/60 bg-amber-500/90 text-slate-950 hover:bg-amber-400'
            : 'border-slate-700/70 bg-slate-900/85 text-slate-300 hover:bg-slate-800'
        }`}
        aria-label="Rotation nowcasts"
      >
        <span aria-hidden>🌀</span>
        {count > 0 ? `${count} rotation nowcast${count === 1 ? '' : 's'}` : 'Nowcasts: clear'}
      </button>
    </div>
  );
}
