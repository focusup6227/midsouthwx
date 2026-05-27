'use client';

import { useTransition } from 'react';
import { deleteLogEntry } from './actions';

type Entry = {
  id: string;
  occurred_at: string;
  created_at: string;
  body: string;
  tags: string[];
  severity: 'info' | 'warning' | 'critical';
  refs: Record<string, unknown> | null;
};

const SEV_STYLE: Record<Entry['severity'], string> = {
  info: 'border-wx-line text-wx-mute',
  warning: 'border-amber-400/60 text-amber-200 bg-amber-500/5',
  critical: 'border-red-400/60 text-red-200 bg-red-500/5',
};

export default function LogRow({ entry }: { entry: Entry }) {
  const [pending, startTransition] = useTransition();
  const ts = new Date(entry.occurred_at);
  const tsLabel = ts.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className={`flex gap-3 rounded-lg border p-3 ${SEV_STYLE[entry.severity]}`}>
      <div className="shrink-0 w-[120px] font-mono text-[11px] text-wx-mute pt-0.5">
        <div>{tsLabel}</div>
        <div className="uppercase tracking-wider mt-0.5 text-[9.5px]">
          {entry.severity}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <div className="whitespace-pre-wrap break-words text-sm text-wx-fg">
          {entry.body}
        </div>
        {entry.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {entry.tags.map((t) => (
              <a
                key={t}
                href={`/log?tag=${encodeURIComponent(t)}`}
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-wx-ink border border-wx-line text-wx-mute hover:text-wx-fg"
              >
                #{t}
              </a>
            ))}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => {
          if (!confirm('Delete this entry?')) return;
          startTransition(() => { void deleteLogEntry(entry.id); });
        }}
        disabled={pending}
        className="shrink-0 self-start text-wx-mute hover:text-red-300 text-[10px] disabled:opacity-50"
        title="Delete entry"
      >
        ✕
      </button>
    </div>
  );
}
