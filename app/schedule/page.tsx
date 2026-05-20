import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import CancelScheduleButton from './CancelScheduleButton';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

export default async function ScheduleListPage() {
  const supa = supabaseServer();
  const { data: rows } = await supa
    .from('scheduled_messages')
    .select(
      'id, body_md, status, scheduled_for, next_run_at, rrule, last_error, dispatch_attempts, created_at',
    )
    .order('next_run_at', { ascending: true, nullsFirst: false });

  return (
    <DashShell
      title="Scheduled alerts"
      actions={<Link href="/schedule/new" className="btn">New schedule</Link>}
    >
      <p className="text-wx-mute text-sm">
        Fires automatically via <code className="text-xs">scheduled-dispatcher</code> (every minute).
      </p>

      {!rows?.length ? (
        <p className="text-wx-mute text-sm">No schedules yet.</p>
      ) : (
        <ul className="divide-y divide-wx-line card">
          {rows.map((r) => (
            <li key={r.id} className="p-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="font-medium truncate">{r.body_md.slice(0, 100)}</div>
                <div className="text-xs text-wx-mute flex flex-wrap gap-x-3 gap-y-1">
                  <span className="uppercase">{r.status}</span>
                  <span>next: {r.next_run_at ? new Date(r.next_run_at).toLocaleString() : '—'}</span>
                  {r.rrule ? <span>recurring</span> : <span>one-shot</span>}
                </div>
                {r.last_error && r.status === 'failed' ? (
                  <div className="text-xs text-wx-danger">Last error: {r.last_error}</div>
                ) : null}
              </div>
              <div className="flex gap-2 shrink-0">
                {(r.status === 'pending' || r.status === 'failed') && (
                  <>
                    <Link href={`/schedule/${r.id}`} className="btn-ghost text-sm">
                      Edit
                    </Link>
                    <CancelScheduleButton id={r.id} />
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </DashShell>
  );
}
