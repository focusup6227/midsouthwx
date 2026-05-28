'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  disableForecastSharing,
  enableForecastSharing,
} from '../../actions';

export default function ForecastShareCard({
  id,
  publicToken,
  shareUrl,
  broadcastMessageId,
  broadcastAt,
}: {
  id: string;
  publicToken: string | null;
  shareUrl: string | null;
  broadcastMessageId: string | null;
  broadcastAt: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const run = (fn: () => Promise<unknown>) => () => {
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'failed');
      }
    });
  };

  return (
    <div className="rounded-lg border border-wx-line bg-wx-card p-3 space-y-2">
      <div className="font-semibold uppercase tracking-wider text-[10px]">Share</div>
      {publicToken ? (
        <>
          {shareUrl ? (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareUrl}
                className="flex-1 bg-wx-ink border border-wx-line rounded px-2 py-1 text-[11px] font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className="text-[11px] text-wx-accent hover:underline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(shareUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {}
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <div className="text-[11px] text-wx-mute">
              Set <code>NEXT_PUBLIC_SITE_URL</code> to surface the share URL here.
            </div>
          )}
          <button
            type="button"
            disabled={pending}
            className="btn-ghost text-[11px] text-wx-mute"
            onClick={() => {
              if (!confirm('Revoke this share link? Anyone with the old URL will get a 404.')) return;
              run(() => disableForecastSharing(id))();
            }}
          >
            {pending ? '…' : 'Revoke link'}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={pending}
          className="btn-ghost text-[11px] text-sky-300"
          onClick={run(() => enableForecastSharing(id))}
        >
          {pending ? '…' : 'Create public link'}
        </button>
      )}

      <div className="border-t border-wx-line/60 pt-2">
        <div className="font-semibold uppercase tracking-wider text-[10px]">Broadcast</div>
        {broadcastMessageId ? (
          <div className="text-[11px] mt-0.5 space-y-0.5">
            <div className="text-emerald-300">
              Sent {broadcastAt ? new Date(broadcastAt).toLocaleString() : ''}
            </div>
            <a
              href={`/m/${broadcastMessageId}`}
              target="_blank"
              rel="noreferrer"
              className="text-wx-accent hover:underline"
            >
              View delivery →
            </a>
          </div>
        ) : (
          <div className="text-[11px] text-wx-mute mt-0.5">
            Not yet broadcast. Use the button above the title to fanout to subscribers in the polygon.
          </div>
        )}
      </div>
    </div>
  );
}
