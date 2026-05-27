// F14: CSV / Markdown export of operator event log entries.
//
// Filters mirror the page's query params (tag, severity, free-text). Auth
// goes through the RLS-respecting supabaseServer client, so a non-operator
// hitting this URL gets an empty file. Maximum 5,000 rows per export so a
// runaway query can't generate a 100 MB file.

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type Entry = {
  id: string;
  occurred_at: string;
  created_at: string;
  body: string;
  tags: string[] | null;
  severity: 'info' | 'warning' | 'critical';
};

const MAX_ROWS = 5_000;

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(entries: Entry[]): string {
  const lines = ['occurred_at,severity,tags,body'];
  for (const e of entries) {
    lines.push(
      [
        csvEscape(e.occurred_at),
        csvEscape(e.severity),
        csvEscape((e.tags ?? []).join(' ')),
        csvEscape(e.body),
      ].join(','),
    );
  }
  return lines.join('\n');
}

function toMarkdown(entries: Entry[]): string {
  const lines: string[] = [];
  lines.push(`# Event log — exported ${new Date().toISOString()}`);
  lines.push('');
  // Newest-first matches what the operator sees on the page.
  for (const e of entries) {
    const ts = new Date(e.occurred_at).toISOString();
    const tagPart = (e.tags ?? []).length > 0 ? ' ' + (e.tags ?? []).map((t) => `#${t}`).join(' ') : '';
    lines.push(`## ${ts} · ${e.severity.toUpperCase()}${tagPart}`);
    lines.push('');
    lines.push(e.body);
    lines.push('');
  }
  return lines.join('\n');
}

export async function GET(req: Request) {
  const supa = supabaseServer();
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') || 'csv').toLowerCase();
  const tag = (url.searchParams.get('tag') || '').trim().toLowerCase();
  const sev = (url.searchParams.get('sev') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();

  let query = supa
    .from('event_log_entries')
    .select('id, occurred_at, created_at, body, tags, severity')
    .order('occurred_at', { ascending: false })
    .limit(MAX_ROWS);

  if (tag) query = query.contains('tags', [tag]);
  if (sev === 'info' || sev === 'warning' || sev === 'critical') query = query.eq('severity', sev);
  if (q) query = query.ilike('body', `%${q}%`);

  const { data, error } = await query.returns<Entry[]>();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const entries = data ?? [];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (format === 'md' || format === 'markdown') {
    return new NextResponse(toMarkdown(entries), {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="event-log-${stamp}.md"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  return new NextResponse(toCsv(entries), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="event-log-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
