'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { supabaseBrowser } from '@/lib/supabase/client';

// "What have I already sent?" — during a multi-warning night the operator
// loses track of which areas were alerted. Small pill above the radar's
// bottom-right controls listing outbound messages from the last 2 hours with
// status + recipient count; expands to a linked list. Renders nothing when
// the window is empty so quiet days stay clean.

type Row = {
  id: string;
  body_md: string;
  status: string;
  recipient_count: number | null;
  created_at: string;
};

async function fetchRecent(): Promise<Row[]> {
  const supa = supabaseBrowser();
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const { data } = await supa
    .from('messages')
    .select('id, body_md, status, recipient_count, created_at')
    .gte('created_at', since)
    .in('status', ['queued', 'sending', 'sent'])
    .order('created_at', { ascending: false })
    .limit(6);
  return (data ?? []) as Row[];
}

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

export default function RecentSends() {
  const { data } = useSWR('radar-recent-sends', fetchRecent, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });
  const [open, setOpen] = useState(false);
  const rows = data ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="absolute bottom-16 right-3 z-30 md:right-4 flex flex-col items-end gap-1.5">
      {open ? (
        <div className="w-[300px] rounded-xl border border-wx-line bg-wx-card/95 p-2 shadow-2xl backdrop-blur">
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-wx-mute">
            Sent · last 2h
          </div>
          <ul className="divide-y divide-wx-line">
            {rows.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/alerts/${r.id}`}
                  target="_blank"
                  className="block rounded px-1.5 py-1.5 hover:bg-wx-ink"
                >
                  <div className="truncate text-[12px] text-wx-fg">{r.body_md}</div>
                  <div className="text-[10.5px] text-wx-mute">
                    {ago(r.created_at)} ago · {r.recipient_count ?? 0} recipient
                    {(r.recipient_count ?? 0) === 1 ? '' : 's'} ·{' '}
                    <span className={r.status === 'sent' ? 'text-wx-ok' : 'text-amber-400'}>{r.status}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border border-wx-line bg-wx-card/95 px-2.5 py-1 text-[11px] font-semibold text-wx-mute shadow-lg backdrop-blur hover:text-wx-fg"
        aria-expanded={open}
      >
        ↗ {rows.length} sent · {ago(rows[0].created_at)}
      </button>
    </div>
  );
}
