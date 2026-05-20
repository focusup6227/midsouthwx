'use client';

import { useState, useTransition } from 'react';
import { approveNwsMessage, rejectNwsMessage } from './actions';

export default function NwsApproveButtons({ messageId }: { messageId: string }) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function run(fn: typeof approveNwsMessage) {
    setErr(null);
    startTransition(async () => {
      const res = await fn(messageId);
      if ('error' in res && res.error) setErr(res.error);
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={pending} onClick={() => run(approveNwsMessage)}>
          Approve & queue
        </button>
        <button type="button" className="btn-ghost text-wx-danger border border-wx-danger/40" disabled={pending} onClick={() => run(rejectNwsMessage)}>
          Reject
        </button>
      </div>
      {err ? <p className="text-sm text-wx-danger">{err}</p> : null}
    </div>
  );
}
