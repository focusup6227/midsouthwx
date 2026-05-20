import { supabaseServer } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import ScheduleForm from '../ScheduleForm';
import type { AudienceSpecT } from '../actions';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

export default async function EditSchedulePage({ params }: { params: { id: string } }) {
  const supa = supabaseServer();
  const id = params.id;

  const [{ data: row }, templatesRes, groupsRes, regionsRes, subsRes] = await Promise.all([
    supa
      .from('scheduled_messages')
      .select(
        'id, body_md, audience_spec, template_id, scheduled_for, rrule, status',
      )
      .eq('id', id)
      .maybeSingle(),
    supa.from('templates').select('id, name, category, body_md, default_quick_replies').order('name'),
    supa.from('custom_groups').select('id, name').order('name'),
    supa.from('regions').select('id, name, kind').order('name'),
    supa
      .from('subscribers')
      .select('id, display_name, telegram_chat_id')
      .eq('status', 'active')
      .order('display_name'),
  ]);

  if (!row) notFound();

  const editable = row.status === 'pending' || row.status === 'failed';

  return (
    <DashShell title="Edit schedule" backHref="/schedule" width="narrow">
      <p className="text-xs text-wx-mute uppercase">status: {row.status}</p>

      {!editable ? (
        <p className="text-wx-mute text-sm">
          This schedule is {row.status} and cannot be edited. Create a new schedule instead.
        </p>
      ) : (
        <ScheduleForm
          scheduleId={row.id}
          templates={templatesRes.data ?? []}
          groups={groupsRes.data ?? []}
          regions={regionsRes.data ?? []}
          subscribers={subsRes.data ?? []}
          initial={{
            body_md: row.body_md,
            audience_spec: row.audience_spec as AudienceSpecT,
            template_id: row.template_id,
            scheduled_for: row.scheduled_for,
            rrule: row.rrule,
          }}
        />
      )}
    </DashShell>
  );
}
