'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  dismissReport,
  forwardReportToNearby,
  reopenReport,
  verifyReport,
} from './actions';

const FORWARD_RADII = [3, 5, 10] as const;

export default function ReportActions({
  id,
  status,
  promotedMessageId,
  hasPhoto,
}: {
  id: string;
  status: 'new' | 'verified' | 'promoted' | 'dismissed';
  promotedMessageId: string | null;
  hasPhoto?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardRadius, setForwardRadius] = useState<number>(5);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>) => () => {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed');
      }
    });
  };

  if (status === 'promoted') {
    return (
      <div className="flex flex-col gap-1 pt-1">
        <div className="flex gap-2">
          {promotedMessageId ? (
            <Link
              href={`/m/${promotedMessageId}`}
              className="btn-ghost text-xs flex-1 text-center"
            >
              View broadcast
            </Link>
          ) : null}
          {hasPhoto ? (
            <button
              type="button"
              className="btn-ghost text-xs flex-1 text-sky-300"
              disabled={pending}
              onClick={() => setForwardOpen((v) => !v)}
            >
              {forwardOpen ? 'Close' : 'Forward photo'}
            </button>
          ) : null}
        </div>
        {forwardOpen ? <ForwardControls
          forwardRadius={forwardRadius}
          setForwardRadius={setForwardRadius}
          pending={pending}
          run={(km) => run(async () => {
            await forwardReportToNearby({ id, radius_km: km });
            setForwardOpen(false);
          })}
        /> : null}
        {error ? <div className="text-[10px] text-wx-danger">{error}</div> : null}
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
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex gap-2">
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
      {hasPhoto ? (
        <button
          type="button"
          className="btn-ghost text-[11px] text-sky-300 self-start"
          disabled={pending}
          onClick={() => setForwardOpen((v) => !v)}
        >
          {forwardOpen ? '✕ Close forward' : '📷 Forward photo to nearby'}
        </button>
      ) : null}
      {forwardOpen ? <ForwardControls
        forwardRadius={forwardRadius}
        setForwardRadius={setForwardRadius}
        pending={pending}
        run={(km) => run(async () => {
          await forwardReportToNearby({ id, radius_km: km });
          setForwardOpen(false);
        })}
      /> : null}
      {error ? <div className="text-[10px] text-wx-danger">{error}</div> : null}
    </div>
  );
}

function ForwardControls({
  forwardRadius,
  setForwardRadius,
  pending,
  run,
}: {
  forwardRadius: number;
  setForwardRadius: (n: number) => void;
  pending: boolean;
  run: (km: number) => () => void;
}) {
  return (
    <div className="bg-wx-ink/60 rounded-md p-2 space-y-1.5">
      <div className="text-[10px] text-wx-mute">
        Send the photo + brief caption to active subscribers within:
      </div>
      <div className="flex gap-1">
        {FORWARD_RADII.map((km) => (
          <button
            key={km}
            type="button"
            onClick={() => setForwardRadius(km)}
            className={
              'px-2 py-0.5 rounded-full text-[10px] border ' +
              (forwardRadius === km
                ? 'bg-sky-400/15 border-sky-400 text-sky-300'
                : 'border-wx-line text-wx-mute hover:text-wx-fg')
            }
          >
            {km} km
          </button>
        ))}
        <button
          type="button"
          disabled={pending}
          className="btn-ghost text-[11px] ml-auto text-sky-300"
          onClick={run(forwardRadius)}
        >
          {pending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
