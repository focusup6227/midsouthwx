import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import CheckinTally from './CheckinTally';

export const dynamic = 'force-dynamic';

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-wx-mute',
  sending: 'text-wx-accent',
  sent: 'text-wx-ok',
  failed: 'text-wx-danger',
  skipped: 'text-wx-mute',
};

type Spec = { all?: boolean; groups?: string[]; regions?: string[]; subscribers?: string[] };

export default async function AlertDetail({ params }: { params: { id: string } }) {
  const supa = supabaseServer();

  const { data: msg } = await supa
    .from('messages')
    .select('id, body_md, source, status, audience_spec, quick_replies, template_id, recipient_count, created_at, sent_at')
    .eq('id', params.id)
    .single();

  if (!msg) notFound();

  const spec = (msg.audience_spec ?? {}) as Spec;

  const [groupRes, regionRes, subRes, queueRes, checkinRes] = await Promise.all([
    spec.groups?.length
      ? supa.from('custom_groups').select('id, name').in('id', spec.groups)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    spec.regions?.length
      ? supa.from('regions').select('id, name').in('id', spec.regions)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    spec.subscribers?.length
      ? supa.from('subscribers').select('id, display_name').in('id', spec.subscribers)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    supa.from('outbound_queue').select('status').eq('message_id', params.id),
    msg.source === 'checkin'
      ? supa.from('check_in_responses').select('response_code').eq('message_id', params.id)
      : Promise.resolve({ data: [] as { response_code: string | null }[] }),
  ]);

  const tally: Record<string, number> = {};
  for (const r of queueRes.data ?? []) tally[r.status] = (tally[r.status] ?? 0) + 1;

  const checkinTally: Record<string, number> = {};
  for (const r of checkinRes.data ?? []) {
    const code = r.response_code ?? '(other)';
    checkinTally[code] = (checkinTally[code] ?? 0) + 1;
  }

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <Link href="/alerts" className="text-wx-mute text-sm">← Alerts</Link>
        <h1 className="text-2xl font-bold">Alert detail</h1>
      </div>

      <section className="card p-5 space-y-3">
        <div className="flex flex-wrap gap-4 text-xs text-wx-mute">
          <span>Status: <span className="text-wx-fg">{msg.status}</span></span>
          <span>Source: <span className="text-wx-fg">{msg.source}</span></span>
          <span>Recipients: <span className="text-wx-fg">{msg.recipient_count ?? 0}</span></span>
          <span>Created: <span className="text-wx-fg">{new Date(msg.created_at).toLocaleString()}</span></span>
          {msg.sent_at && <span>Sent: <span className="text-wx-fg">{new Date(msg.sent_at).toLocaleString()}</span></span>}
        </div>
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{msg.body_md}</pre>
        {Array.isArray(msg.quick_replies) && msg.quick_replies.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-2">
            {(msg.quick_replies as { label: string; data: string }[]).map((qr, i) => (
              <span key={i} className="btn-ghost text-xs">
                {qr.label}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Audience</h2>
        {spec.all ? (
          <p className="text-sm">All active subscribers</p>
        ) : (
          <ul className="text-sm space-y-1">
            {(groupRes.data ?? []).map((g) => (
              <li key={g.id}>Group · {g.name}</li>
            ))}
            {(regionRes.data ?? []).map((r) => (
              <li key={r.id}>Region · {r.name}</li>
            ))}
            {(subRes.data ?? []).map((s) => (
              <li key={s.id}>Subscriber · {s.display_name}</li>
            ))}
            {!groupRes.data?.length && !regionRes.data?.length && !subRes.data?.length && (
              <li className="text-wx-mute">No audience members specified.</li>
            )}
          </ul>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Delivery</h2>
        {Object.keys(tally).length === 0 ? (
          <p className="text-wx-mute text-sm">No outbound rows yet.</p>
        ) : (
          <div className="flex flex-wrap gap-4 text-sm">
            {Object.entries(tally).map(([status, n]) => (
              <span key={status} className={STATUS_COLOR[status] ?? ''}>
                {status}: <strong className="text-wx-fg">{n}</strong>
              </span>
            ))}
          </div>
        )}
      </section>

      {msg.source === 'checkin' && (
        <CheckinTally
          messageId={msg.id}
          initial={checkinTally}
          recipientCount={msg.recipient_count ?? 0}
        />
      )}
    </main>
  );
}
