import { supabaseServer } from '@/lib/supabase/server';
import ComposeForm from './ComposeForm';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

export default async function ComposePage({
  searchParams,
}: {
  searchParams: { geo?: string };
}) {
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
    <DashShell title="New alert" width="narrow">
      <ComposeForm
        templates={templatesRes.data ?? []}
        groups={groupsRes.data ?? []}
        regions={regionsRes.data ?? []}
        subscribers={subsRes.data ?? []}
        initialGeometry={searchParams.geo ? JSON.parse(searchParams.geo) : null}
      />
    </DashShell>
  );
}
