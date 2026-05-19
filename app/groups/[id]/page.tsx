import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import GroupMembers from './GroupMembers';

export const dynamic = 'force-dynamic';

export default async function GroupDetail({ params }: { params: { id: string } }) {
  const supa = supabaseServer();

  const [{ data: group }, { data: members }, { data: allSubs }] = await Promise.all([
    supa.from('custom_groups').select('id, name, description, created_at').eq('id', params.id).single(),
    supa
      .from('group_memberships')
      .select('subscriber_id, subscribers(id, display_name, status, telegram_chat_id)')
      .eq('group_id', params.id),
    supa
      .from('subscribers')
      .select('id, display_name, status, telegram_chat_id')
      .order('display_name'),
  ]);

  if (!group) notFound();

  const memberRows = (members ?? []).map((m) => {
    const s = Array.isArray(m.subscribers) ? m.subscribers[0] : m.subscribers;
    return s ? { id: s.id, display_name: s.display_name, status: s.status, telegram_chat_id: s.telegram_chat_id } : null;
  }).filter((x): x is { id: string; display_name: string; status: string; telegram_chat_id: number | null } => !!x);

  const memberIdSet = new Set(memberRows.map((m) => m.id));
  const candidates = (allSubs ?? []).filter((s) => !memberIdSet.has(s.id));

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <Link href="/groups" className="text-wx-mute text-sm">← Groups</Link>
        <h1 className="text-2xl font-bold">{group.name}</h1>
        {group.description && <p className="text-sm text-wx-mute">{group.description}</p>}
      </div>

      <GroupMembers
        groupId={group.id}
        members={memberRows}
        candidates={candidates}
      />
    </main>
  );
}
