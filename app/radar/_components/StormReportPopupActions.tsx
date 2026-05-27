'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  dismissReport,
  forwardReportToNearby,
  promoteReport,
  verifyReport,
} from '@/app/reports/actions';
import { defaultPromotionBody } from '@/app/reports/promotion-template';

type Report = {
  id: string;
  hazard: string;
  description: string | null;
  photo_url: string | null;
  reported_at: string | null;
  reporter: string | null;
  place_name: string | null;
  status: string | null;
  lat: number;
  lon: number;
};

const RADII = [10, 25, 50, 100] as const;

// Inline triage actions for the storm-report popup on /radar. Keeps the
// operator on the map: verify/dismiss commit in place, promote opens a tiny
// in-popup form (radius + editable body) and broadcasts via the same server
// action that /reports/[id]/promote uses.
export default function StormReportPopupActions({
  report,
  onActed,
}: {
  report: Report;
  onActed: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<'idle' | 'promote' | 'forward'>('idle');
  const [radius, setRadius] = useState(25);
  const [forwardRadius, setForwardRadius] = useState(5);
  const [body, setBody] = useState(() =>
    defaultPromotionBody({
      hazard: report.hazard,
      place_name: report.place_name,
      lat: report.lat,
      lon: report.lon,
      description: report.description,
    }),
  );
  const [error, setError] = useState<string | null>(null);

  if (report.status === 'promoted') {
    return (
      <div className="pt-1 space-y-1">
        <div className="text-[10px] text-wx-mute flex justify-between items-center">
          <span>Already promoted</span>
          <Link href="/reports" className="text-wx-accent hover:underline">
            Triage →
          </Link>
        </div>
        {report.photo_url ? (
          <button
            type="button"
            className="btn-ghost text-[10px] text-sky-300 w-full"
            disabled={pending}
            onClick={() => setMode(mode === 'forward' ? 'idle' : 'forward')}
          >
            {mode === 'forward' ? '✕ Close' : '📷 Forward photo to nearby'}
          </button>
        ) : null}
        {mode === 'forward' ? renderForward() : null}
        {error ? <div className="text-[10px] text-wx-danger">{error}</div> : null}
      </div>
    );
  }

  function renderForward() {
    return (
      <div className="bg-wx-ink/60 rounded-md p-2 space-y-1.5 mt-1">
        <div className="text-[10px] text-wx-mute">Send photo to subscribers within:</div>
        <div className="flex gap-1">
          {[3, 5, 10].map((km) => (
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
            onClick={() => {
              setError(null);
              startTransition(async () => {
                try {
                  await forwardReportToNearby({ id: report.id, radius_km: forwardRadius });
                  onActed();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'failed');
                }
              });
            }}
          >
            {pending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'forward') {
    return (
      <div className="pt-1 space-y-1">
        {renderForward()}
        <button
          type="button"
          className="btn-ghost text-[10px] w-full"
          onClick={() => setMode('idle')}
        >
          Cancel
        </button>
        {error ? <div className="text-[10px] text-wx-danger">{error}</div> : null}
      </div>
    );
  }

  if (mode === 'promote') {
    return (
      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap gap-1">
          {RADII.map((km) => (
            <button
              key={km}
              type="button"
              onClick={() => setRadius(km)}
              className={
                'px-2 py-0.5 rounded-full text-[10px] border ' +
                (radius === km
                  ? 'bg-sky-400/15 border-sky-400 text-sky-300'
                  : 'border-wx-line text-wx-mute hover:text-wx-fg')
              }
            >
              {km} km
            </button>
          ))}
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          className="w-full bg-wx-ink border border-wx-line rounded-md p-2 text-[10.5px] font-mono leading-snug"
        />
        {error ? <div className="text-[10px] text-wx-danger">{error}</div> : null}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending || !body.trim()}
            className="btn-ghost text-[11px] flex-1 text-sky-300"
            onClick={() => {
              setError(null);
              startTransition(async () => {
                try {
                  await promoteReport({ id: report.id, body_md: body, radius_km: radius });
                  onActed();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'failed');
                }
              });
            }}
          >
            {pending ? 'Sending…' : 'Send broadcast'}
          </button>
          <button
            type="button"
            disabled={pending}
            className="btn-ghost text-[11px]"
            onClick={() => setMode('idle')}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1 pt-1">
    <div className="flex gap-1.5">
      {report.status !== 'verified' ? (
        <button
          type="button"
          disabled={pending}
          className="btn-ghost text-[10px] flex-1 text-emerald-300"
          onClick={() => startTransition(async () => { await verifyReport(report.id); onActed(); })}
        >
          {pending ? '…' : 'Verify'}
        </button>
      ) : null}
      <button
        type="button"
        disabled={pending}
        className="btn-ghost text-[10px] flex-1 text-sky-300"
        onClick={() => setMode('promote')}
      >
        Promote
      </button>
      <button
        type="button"
        disabled={pending}
        className="btn-ghost text-[10px] flex-1 text-wx-mute"
        onClick={() => startTransition(async () => { await dismissReport(report.id); onActed(); })}
      >
        {pending ? '…' : 'Dismiss'}
      </button>
    </div>
    {report.photo_url ? (
      <button
        type="button"
        className="btn-ghost text-[10px] w-full text-sky-300"
        disabled={pending}
        onClick={() => setMode('forward')}
      >
        📷 Forward photo to nearby
      </button>
    ) : null}
    {error ? <div className="text-[10px] text-wx-danger">{error}</div> : null}
    </div>
  );
}
