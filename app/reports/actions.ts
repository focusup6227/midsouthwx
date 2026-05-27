'use server';

import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

async function requireOperator(): Promise<{ userId: string }> {
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) throw new Error('not authenticated');
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!op) throw new Error('operators only');
  return { userId };
}

export async function verifyReport(id: string): Promise<void> {
  const { userId } = await requireOperator();
  const supa = supabaseServer();
  await supa
    .from('telegram_storm_reports')
    .update({ status: 'verified', verified_at: new Date().toISOString(), verified_by: userId })
    .eq('id', id);
  revalidatePath('/reports');
}

export async function dismissReport(id: string): Promise<void> {
  const { userId } = await requireOperator();
  const supa = supabaseServer();
  await supa
    .from('telegram_storm_reports')
    .update({ status: 'dismissed', dismissed_at: new Date().toISOString(), dismissed_by: userId })
    .eq('id', id);
  revalidatePath('/reports');
}

export async function reopenReport(id: string): Promise<void> {
  await requireOperator();
  const supa = supabaseServer();
  await supa
    .from('telegram_storm_reports')
    .update({
      status: 'new',
      verified_at: null, verified_by: null,
      dismissed_at: null, dismissed_by: null,
    })
    .eq('id', id);
  revalidatePath('/reports');
}

export async function promoteReport(input: {
  id: string;
  body_md: string;
  radius_km: number;
}): Promise<{ message_id: string; count: number }> {
  const { userId } = await requireOperator();
  const supa = supabaseServer();
  const admin = supabaseAdmin();

  const { data: report } = await supa
    .from('telegram_storm_reports')
    .select('id, status, lat, lon, hazard, place_name')
    .eq('id', input.id)
    .maybeSingle();
  if (!report) throw new Error('report not found');
  if (report.status === 'promoted') throw new Error('report already promoted');

  const radiusKm = Math.max(1, Math.min(200, Math.round(input.radius_km)));
  const body = input.body_md.trim();
  if (!body) throw new Error('body cannot be empty');

  const audienceSpec = {
    geometry: {
      type: 'circle' as const,
      center: [report.lon, report.lat] as [number, number],
      radius_km: radiusKm,
    },
  };

  const { data: msg, error: insertErr } = await admin
    .from('messages')
    .insert({
      body_md: body,
      body_rendered: body,
      source: 'manual',
      status: 'draft',
      audience_spec: audienceSpec,
      created_by: userId,
    })
    .select('id')
    .single();
  if (insertErr || !msg) throw new Error(insertErr?.message ?? 'insert failed');

  const { data: count, error: enqErr } = await admin.rpc('enqueue_message_system', {
    p_message_id: msg.id,
  });
  if (enqErr) {
    await admin.from('messages').update({ status: 'failed' }).eq('id', msg.id);
    throw new Error(enqErr.message);
  }

  await admin
    .from('telegram_storm_reports')
    .update({
      status: 'promoted',
      promoted_at: new Date().toISOString(),
      promoted_by: userId,
      promoted_message_id: msg.id,
    })
    .eq('id', input.id);

  revalidatePath('/reports');
  revalidatePath('/dashboard');
  return { message_id: msg.id, count: count as unknown as number };
}

export async function promoteReportFromForm(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const body_md = String(formData.get('body_md') ?? '');
  const radius_km = Number(formData.get('radius_km') ?? 25);
  const { message_id } = await promoteReport({ id, body_md, radius_km });
  redirect(`/m/${message_id}`);
}
