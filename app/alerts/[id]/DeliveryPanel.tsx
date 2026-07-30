'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { retryFailedDeliveries, remindNonResponders } from './delivery-actions';
import { toast } from '@/components/toast';

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-wx-mute',
  sending: 'text-wx-accent',
  sent: 'text-wx-ok',
  failed: 'text-wx-danger',
  skipped: 'text-wx-mute',
};

export type FailedRow = {
  subscriberId: string;
  name: string;
  linked: boolean;
  error: string | null;
};

/**
 * Actionable delivery breakdown: who didn't get it, why, and one-click
 * recovery (retry failures / remind check-in non-responders).
 */
export default function DeliveryPanel({
  messageId,
  tally,
  failed,
  nonResponderCount,
  isCheckin,
}: {
  messageId: string;
  tally: Record<string, number>;
  failed: FailedRow[];
  nonResponderCount: number;
  isCheckin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [showFailed, setShowFailed] = useState(false);
  const router = useRouter();

  const failedCount = tally.failed ?? 0;
  const unlinked = failed.filter((f) => !f.linked).length;

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold">Delivery</h2>
      {Object.keys(tally).length === 0 ? (
        <p className="text-wx-mute text-sm">No outbound rows yet.</p>
      ) : (
        <div className="flex flex-wrap gap-4 text-sm">
          {Object.entries(tally).map(([status, n]) => (
            <span key={status} className={STATUS_COLOR[status] ?? ''}>
              {status}: <strong className="text-wx-fg">{n}</strong>
            </span>
          ))}
        </div>
      )}

      {failedCount > 0 ? (
        <div className="space-y-2 rounded-lg border border-wx-danger/40 bg-wx-danger/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-wx-danger">
              {failedCount} delivery{failedCount === 1 ? '' : 'ies'} failed
              {unlinked > 0 ? ` (${unlinked} never linked Telegram)` : ''}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setShowFailed((v) => !v)}
              >
                {showFailed ? 'Hide' : 'Show who'}
              </button>
              <button
                type="button"
                className="btn text-xs"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const res = await retryFailedDeliveries(messageId);
                    if ('error' in res) toast.error(res.error);
                    else {
                      toast.success(`Re-queued ${res.retried} deliveries — worker picks them up within a minute`);
                      router.refresh();
                    }
                  })
                }
              >
                {pending ? 'Working…' : 'Retry failed'}
              </button>
            </div>
          </div>
          {showFailed ? (
            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs wx-scroll">
              {failed.map((f) => (
                <li key={f.subscriberId} className="flex items-baseline justify-between gap-3">
                  <a href={`/subscribers/${f.subscriberId}`} className="text-wx-accent shrink-0">
                    {f.name}
                  </a>
                  <span className="truncate text-wx-mute" title={f.error ?? ''}>
                    {f.linked ? (f.error ?? 'unknown error') : 'not linked — needs /start'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {isCheckin && nonResponderCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-wx-line bg-wx-ink/40 p-3 text-sm">
          <span>
            <strong className="text-wx-fg">{nonResponderCount}</strong> recipient
            {nonResponderCount === 1 ? '' : 's'} haven&apos;t answered the check-in
          </span>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={pending}
            onClick={() => {
              if (!window.confirm(`Send a follow-up check-in to ${nonResponderCount} non-responder${nonResponderCount === 1 ? '' : 's'}?`)) return;
              startTransition(async () => {
                const res = await remindNonResponders(messageId);
                if ('error' in res) toast.error(res.error);
                else {
                  toast.success(`Reminder queued to ${res.reminded} — responses land on the new message`);
                  router.refresh();
                }
              });
            }}
          >
            {pending ? 'Working…' : 'Remind non-responders'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
