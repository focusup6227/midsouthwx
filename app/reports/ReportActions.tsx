'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { dismissReport, reopenReport, verifyReport } from './actions';

export default function ReportActions({
  id,
  status,
  promotedMessageId,
}: {
  id: string;
  status: 'new' | 'verified' | 'promoted' | 'dismissed';
  promotedMessageId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<void>) => () => {
    startTransition(async () => {
      await fn();
      router.refresh();
    });
  };

  if (status === 'promoted') {
    return (
      <div className="flex gap-2 pt-1">
        {promotedMessageId ? (
          <Link
            href={`/m/${promotedMessageId}`}
            className="btn-ghost text-xs flex-1 text-center"
          >
            View broadcast
          </Link>
        ) : null}
      </div>
    );
  }

  if (status === 'dismissed') {
    return (
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          className="btn-ghost text-xs flex-1"
          disabled={pending}
          onClick={run(() => reopenReport(id))}
        >
          {pending ? '…' : 'Reopen'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-2 pt-1">
      {status !== 'verified' ? (
        <button
          type="button"
          className="btn-ghost text-xs flex-1 text-emerald-300"
          disabled={pending}
          onClick={run(() => verifyReport(id))}
        >
          {pending ? '…' : 'Verify'}
        </button>
      ) : (
        <button
          type="button"
          className="btn-ghost text-xs flex-1"
          disabled={pending}
          onClick={run(() => reopenReport(id))}
        >
          Mark new
        </button>
      )}
      <Link
        href={`/reports/${id}/promote`}
        className="btn-ghost text-xs flex-1 text-center text-sky-300"
      >
        Promote
      </Link>
      <button
        type="button"
        className="btn-ghost text-xs flex-1 text-wx-mute"
        disabled={pending}
        onClick={run(() => dismissReport(id))}
      >
        {pending ? '…' : 'Dismiss'}
      </button>
    </div>
  );
}
