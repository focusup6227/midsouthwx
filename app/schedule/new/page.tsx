import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import ScheduleForm from '../ScheduleForm';

export const dynamic = 'force-dynamic';

export default async function NewSchedulePage() {
  const supa = supabaseServer();

  const [templatesRes, groupsRes, regionsRes, subsRes] = await Promise.all([
    supa.from('templates').select('id, name, category, body_md, default_quick_replies').order('name'),
    supa.from('custom_groups').select('id, name').order('name'),
    supa.from('regions').select('id, name, kind').order('name'),
    supa
      .from('subscribers')
      .select('id, display_name, telegram_chat_id')
      .eq('status', 'active')
      .order('display_name'),
  ]);

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/schedule" className="text-wx-mute text-sm">
            ← Schedules
          </Link>
          <h1 className="text-2xl font-bold">New schedule</h1>
        </div>
      </div>

      <ScheduleForm
        templates={templatesRes.data ?? []}
        groups={groupsRes.data ?? []}
        regions={regionsRes.data ?? []}
        subscribers={subsRes.data ?? []}
      />
    </main>
  );
}
