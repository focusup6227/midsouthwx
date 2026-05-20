import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import { createGroup } from './actions';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

export default async function GroupsPage() {
  const supa = supabaseServer();

  const [{ data: groups }, { data: memberships }] = await Promise.all([
    supa.from('custom_groups').select('id, name, description, created_at').order('name'),
    supa.from('group_memberships').select('group_id'),
  ]);

  const counts: Record<string, number> = {};
  for (const m of memberships ?? []) counts[m.group_id] = (counts[m.group_id] ?? 0) + 1;

  return (
    <DashShell title="Groups" width="narrow">
      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">New group</h2>
        <form action={createGroup} className="space-y-2">
          <input
            className="input"
            name="name"
            required
            minLength={1}
            placeholder="Group name (e.g. Family)"
          />
          <input
            className="input"
            name="description"
            placeholder="Optional description"
          />
          <div className="flex justify-end">
            <button className="btn" type="submit">Create</button>
          </div>
        </form>
      </section>

      <section className="card divide-y divide-wx-line">
        {groups?.length ? (
          groups.map((g) => (
            <Link
              key={g.id}
              href={`/groups/${g.id}`}
              className="flex items-center justify-between gap-4 p-4 hover:bg-wx-ink/40 transition"
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{g.name}</div>
                {g.description && (
                  <div className="text-xs text-wx-mute mt-0.5 truncate">{g.description}</div>
                )}
              </div>
              <div className="text-xs text-wx-mute whitespace-nowrap">
                {counts[g.id] ?? 0} member{(counts[g.id] ?? 0) === 1 ? '' : 's'}
              </div>
            </Link>
          ))
        ) : (
          <p className="text-wx-mute text-sm p-5">No groups yet.</p>
        )}
      </section>
    </DashShell>
  );
}
