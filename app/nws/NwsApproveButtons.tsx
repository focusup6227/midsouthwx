'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { approveNwsMessage, rejectNwsMessage } from './actions';

type Props = {
  messageId: string;
  /** ISO timestamp set on PDS / Tornado Emergency messages. When non-null,
   *  the buttons render a live countdown and auto-fire `approveNwsMessage`
   *  when the timer hits zero. Operator can still tap Reject during the
   *  countdown to cancel the send. */
  autoSendAt?: string | null;
};

function secondsRemaining(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

export default function NwsApproveButtons({ messageId, autoSendAt = null }: Props) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number>(() => secondsRemaining(autoSendAt));
  const autoFiredRef = useRef(false);

  function run(fn: typeof approveNwsMessage) {
    setErr(null);
    startTransition(async () => {
      const res = await fn(messageId);
      if ('error' in res && res.error) setErr(res.error);
    });
  }

  // Tick the countdown twice per second. When it hits zero AND we haven't
  // already auto-fired, trigger approve. The server-side dispatcher
  // promote_auto_send_messages() RPC is the ground-truth fallback; this
  // client path is the fast path when the operator is watching the
  // dashboard. Approve is invoked inline (instead of via the `run` helper)
  // because `run` closes over a fresh `startTransition` each render and
  // would otherwise need to live in the effect's deps array, causing the
  // interval to thrash every tick.
  useEffect(() => {
    if (!autoSendAt) return;
    setRemaining(secondsRemaining(autoSendAt));
    const id = setInterval(() => {
      const r = secondsRemaining(autoSendAt);
      setRemaining(r);
      if (r === 0 && !autoFiredRef.current) {
        autoFiredRef.current = true;
        clearInterval(id);
        startTransition(async () => {
          const res = await approveNwsMessage(messageId);
          if ('error' in res && res.error) setErr(res.error);
        });
      }
    }, 500);
    return () => clearInterval(id);
  }, [autoSendAt, messageId, startTransition]);

  const countdownActive = !!autoSendAt && remaining > 0;

  return (
    <div className="space-y-2">
      {countdownActive ? (
        <div
          className="rounded border border-wx-danger/50 bg-wx-danger/10 px-2.5 py-1 text-xs font-semibold text-wx-danger text-center"
          role="status"
          aria-live="polite"
        >
          Auto-sending in {remaining}s · tap Reject to cancel
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => run(approveNwsMessage)}
        >
          {countdownActive ? 'Send now' : 'Approve & queue'}
        </button>
        <button
          type="button"
          className="btn-ghost text-wx-danger border border-wx-danger/40"
          disabled={pending}
          onClick={() => run(rejectNwsMessage)}
        >
          Reject
        </button>
      </div>
      {err ? <p className="text-sm text-wx-danger">{err}</p> : null}
    </div>
  );
}
