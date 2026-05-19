'use client';

import { useTransition } from 'react';
import { pauseSubscriber, resumeSubscriber, unsubscribeSubscriber } from './actions';

export default function SubscriberActions({ id, status }: { id: string; status: string }) {
  const [pending, startTransition] = useTransition();

  const run = (fn: (id: string) => Promise<void>) => () => startTransition(() => fn(id));

  return (
    <section className="card p-5 space-y-2">
      <h2 className="font-semibold">Actions</h2>
      <div className="flex gap-2 flex-wrap">
        {status === 'active' && (
          <button className="btn-ghost" onClick={run(pauseSubscriber)} disabled={pending}>
            Pause
          </button>
        )}
        {(status === 'paused' || status === 'pending') && (
          <button className="btn-ghost" onClick={run(resumeSubscriber)} disabled={pending}>
            Activate
          </button>
        )}
        {status !== 'unsubscribed' && (
          <button
            className="btn-ghost text-wx-danger border-wx-danger/40"
            onClick={() => {
              if (confirm('Unsubscribe this subscriber? They will stop receiving alerts.')) {
                run(unsubscribeSubscriber)();
              }
            }}
            disabled={pending}
          >
            Unsubscribe
          </button>
        )}
      </div>
    </section>
  );
}
