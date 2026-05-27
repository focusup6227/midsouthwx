import Link from 'next/link';
import { supabaseServer } from '@/lib/supabase/server';

type Recipient = {
  subscriber_id: string;
  display_name: string | null;
  telegram_username: string | null;
  current_address: string | null;
  home_address: string | null;
  sent_at: string | null;
  response_code: string | null;
  responded_at: string | null;
};

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  safe: { label: '✅ Safe', cls: 'border-emerald-500/40 text-emerald-300' },
  help: { label: '🆘 SOS', cls: 'border-red-500/60 text-red-300' },
  sos:  { label: '🆘 SOS', cls: 'border-red-500/60 text-red-300' },
};

function rowStatus(code: string | null): { label: string; cls: string } {
  if (code && STATUS_STYLE[code]) return STATUS_STYLE[code];
  if (code) return { label: code, cls: 'border-violet-500/40 text-violet-300' };
  return { label: 'silent', cls: 'border-wx-line text-wx-mute' };
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default async function CheckinRecipients({ messageId }: { messageId: string }) {
  const supa = supabaseServer();
  const { data, error } = await supa.rpc('checkin_recipients', { p_message_id: messageId });
  if (error) {
    return (
      <section className="card p-5">
        <p className="text-sm text-wx-danger">checkin_recipients failed: {error.message}</p>
      </section>
    );
  }
  const rows: Recipient[] = (data ?? []) as Recipient[];
  if (rows.length === 0) {
    return (
      <section className="card p-5">
        <p className="text-sm text-wx-mute">No recipients on file for this message.</p>
      </section>
    );
  }
  return (
    <section className="card">
      <header className="border-b border-wx-line px-4 py-2 text-xs uppercase tracking-wider text-wx-mute font-semibold">
        Recipients · {rows.length}
      </header>
      <ul className="divide-y divide-wx-line">
        {rows.map((r) => {
          const status = rowStatus(r.response_code);
          const where = r.current_address ?? r.home_address ?? '';
          return (
            <li key={r.subscriber_id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/subscribers/${r.subscriber_id}`}
                    className="font-medium text-wx-fg truncate hover:text-wx-accent"
                  >
                    {r.display_name ?? 'subscriber'}
                  </Link>
                  {r.telegram_username && (
                    <span className="text-[11px] text-wx-mute">@{r.telegram_username}</span>
                  )}
                </div>
                {where && (
                  <div className="text-[11px] text-wx-mute truncate">
                    {r.current_address ? '📍 at ' : '🏠 '}
                    {where}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0 text-[11px]">
                <span className="text-wx-mute">{timeAgo(r.responded_at ?? r.sent_at)}</span>
                <span className={`inline-block rounded border px-2 py-0.5 font-bold uppercase tracking-wider ${status.cls}`}>
                  {status.label}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
