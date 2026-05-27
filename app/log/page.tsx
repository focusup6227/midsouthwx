// F14: operator event log. Chronological list of timestamped notes /
// decisions / observations the operator types during an event, with
// filters by tag and severity and a CSV / Markdown export so the post-
// event write-up doesn't start from scratch.

import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';
import { redirect } from 'next/navigation';
import LogAddForm from './LogAddForm';
import LogRow from './LogRow';

export const dynamic = 'force-dynamic';

type Entry = {
  id: string;
  occurred_at: string;
  created_at: string;
  body: string;
  tags: string[];
  severity: 'info' | 'warning' | 'critical';
  refs: Record<string, unknown> | null;
};

const DEFAULT_LIMIT = 200;

export default async function LogPage({
  searchParams,
}: {
  searchParams: { tag?: string; sev?: string; q?: string };
}) {
  const supa = supabaseServer();

  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user) redirect('/login?next=/log');

  const tagFilter = (searchParams.tag || '').trim().toLowerCase();
  const sevFilter = (searchParams.sev || '').trim();
  const qFilter = (searchParams.q || '').trim();

  let q = supa
    .from('event_log_entries')
    .select('id, occurred_at, created_at, body, tags, severity, refs')
    .order('occurred_at', { ascending: false })
    .limit(DEFAULT_LIMIT);

  if (tagFilter) q = q.contains('tags', [tagFilter]);
  if (sevFilter === 'info' || sevFilter === 'warning' || sevFilter === 'critical') {
    q = q.eq('severity', sevFilter);
  }
  if (qFilter) q = q.ilike('body', `%${qFilter}%`);

  const { data, error } = await q.returns<Entry[]>();
  const entries = data ?? [];

  // Tag rollup so the operator can see what's busy this week. Counted on
  // the page rather than via a separate RPC since the default 200-row
  // window is tiny.
  const tagCounts = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18);

  return (
    <DashShell
      title="Event log"
      width="wide"
      actions={
        <div className="flex items-center gap-2">
          <a
            href={`/api/log/export?format=csv${tagFilter ? `&tag=${encodeURIComponent(tagFilter)}` : ''}${sevFilter ? `&sev=${sevFilter}` : ''}`}
            className="btn-ghost text-xs"
            title="Download visible entries as CSV"
          >
            Export CSV
          </a>
          <a
            href={`/api/log/export?format=md${tagFilter ? `&tag=${encodeURIComponent(tagFilter)}` : ''}${sevFilter ? `&sev=${sevFilter}` : ''}`}
            className="btn-ghost text-xs"
            title="Download visible entries as Markdown"
          >
            Export MD
          </a>
        </div>
      }
    >
      <div className="space-y-6">
        {error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            Failed to load log: {error.message}
          </div>
        ) : null}

        <section className="rounded-lg border border-wx-line bg-wx-card p-4">
          <h2 className="text-xs uppercase tracking-wider text-wx-mute font-semibold mb-2">
            Add entry
          </h2>
          <LogAddForm />
        </section>

        {topTags.length > 0 ? (
          <section className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-wx-mute mr-1">tags:</span>
            <a
              href="/log"
              className={`px-2 py-0.5 rounded-full text-[11px] border ${
                !tagFilter ? 'border-wx-accent text-wx-accent bg-wx-accent/10' : 'border-wx-line text-wx-mute hover:text-wx-fg'
              }`}
            >
              all
            </a>
            {topTags.map(([t, n]) => (
              <a
                key={t}
                href={`/log?tag=${encodeURIComponent(t)}${sevFilter ? `&sev=${sevFilter}` : ''}`}
                className={`px-2 py-0.5 rounded-full text-[11px] border ${
                  tagFilter === t ? 'border-wx-accent text-wx-accent bg-wx-accent/10' : 'border-wx-line text-wx-mute hover:text-wx-fg'
                }`}
              >
                #{t}
                <span className="ml-1 text-wx-mute/70">{n}</span>
              </a>
            ))}
          </section>
        ) : null}

        <section className="space-y-2">
          {entries.length === 0 ? (
            <div className="rounded border border-wx-line bg-wx-card/60 p-6 text-center text-sm text-wx-mute">
              No entries yet. Add the first one above.
            </div>
          ) : (
            entries.map((e) => <LogRow key={e.id} entry={e} />)
          )}
        </section>
      </div>
    </DashShell>
  );
}
