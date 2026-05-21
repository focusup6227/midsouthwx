import { supabaseServer } from '@/lib/supabase/server';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

function csvEscape(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseDateRange(searchParams: URLSearchParams): { from: Date; to: Date } {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 86400_000);
  const fromRaw = searchParams.get('from');
  const toRaw = searchParams.get('to');
  const from = fromRaw ? new Date(fromRaw) : defaultFrom;
  const to = toRaw ? new Date(toRaw) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Invalid date range');
  }
  return { from, to };
}

export async function GET(req: NextRequest) {
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user) {
    return new Response('Unauthorized', { status: 401 });
  }
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userRes.user.id)
    .maybeSingle();
  if (!op) {
    return new Response('Forbidden', { status: 403 });
  }

  let from: Date;
  let to: Date;
  try {
    ({ from, to } = parseDateRange(req.nextUrl.searchParams));
  } catch {
    return new Response('Invalid date range', { status: 400 });
  }

  const kind = req.nextUrl.searchParams.get('kind') ?? 'messages';

  if (kind === 'delivery') {
    const { data: rows, error } = await supa
      .from('delivery_logs')
      .select('message_id, event, occurred_at, messages(source, body_md)')
      .gte('occurred_at', from.toISOString())
      .lte('occurred_at', to.toISOString())
      .order('occurred_at', { ascending: false })
      .limit(50000);

    if (error) return new Response(error.message, { status: 500 });

    const header = ['message_id', 'source', 'body_preview', 'event', 'occurred_at'].join(',');
    const lines = (rows ?? []).map((r) => {
      const msg = r.messages as { source?: string; body_md?: string } | null;
      return [
        csvEscape(r.message_id),
        csvEscape(msg?.source ?? ''),
        csvEscape((msg?.body_md ?? '').slice(0, 120)),
        csvEscape(r.event),
        csvEscape(r.occurred_at),
      ].join(',');
    });

    const csv = [header, ...lines].join('\n');
    const filename = `delivery-logs-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`;
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  const { data: messages, error: msgErr } = await supa
    .from('messages')
    .select(
      'id, source, status, body_md, recipient_count, created_at, sent_at, nws_alert_id, nws_alerts(event, headline)',
    )
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString())
    .order('created_at', { ascending: false })
    .limit(10000);

  if (msgErr) return new Response(msgErr.message, { status: 500 });

  const header = [
    'id',
    'source',
    'status',
    'body_preview',
    'recipient_count',
    'created_at',
    'sent_at',
    'nws_event',
    'nws_headline',
  ].join(',');

  const lines = (messages ?? []).map((m) => {
    const nws = m.nws_alerts as { event?: string; headline?: string } | null;
    return [
      csvEscape(m.id),
      csvEscape(m.source),
      csvEscape(m.status),
      csvEscape(m.body_md.slice(0, 200)),
      csvEscape(m.recipient_count),
      csvEscape(m.created_at),
      csvEscape(m.sent_at),
      csvEscape(nws?.event ?? ''),
      csvEscape(nws?.headline ?? ''),
    ].join(',');
  });

  const csv = [header, ...lines].join('\n');
  const filename = `alerts-audit-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}
