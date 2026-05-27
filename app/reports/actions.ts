'use server';

import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { sendTelegramDM } from '@/lib/telegram/notify';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

const HAZARD_LABEL: Record<string, string> = {
  tornado: 'tornado',
  funnel: 'funnel cloud',
  wind: 'damaging wind',
  hail: 'hail',
  flood: 'flooding',
  other: 'severe weather',
};

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

/** Resolve a spotter's telegram_chat_id from a report row, then DM them.
 *  Bypasses operator RLS via the admin client because the operator's session
 *  can read the report but not arbitrary subscriber rows. */
async function dmSpotterForReport(reportId: string, text: string): Promise<void> {
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from('telegram_storm_reports')
    .select('subscriber:subscribers(telegram_chat_id)')
    .eq('id', reportId)
    .maybeSingle();
  const sub = Array.isArray(row?.subscriber) ? row?.subscriber[0] : row?.subscriber;
  const chatId = sub?.telegram_chat_id;
  if (!chatId) return;
  await sendTelegramDM(Number(chatId), text);
}

export async function verifyReport(id: string): Promise<void> {
  const { userId } = await requireOperator();
  const supa = supabaseServer();
  const { data: prior } = await supa
    .from('telegram_storm_reports')
    .select('hazard, place_name, status')
    .eq('id', id)
    .maybeSingle();
  await supa
    .from('telegram_storm_reports')
    .update({ status: 'verified', verified_at: new Date().toISOString(), verified_by: userId })
    .eq('id', id);
  // Only DM on the first verification — flipping back-and-forth between
  // verified and new shouldn't bombard the spotter.
  if (prior && prior.status !== 'verified') {
    const hazard = HAZARD_LABEL[prior.hazard] ?? 'storm';
    const place = prior.place_name ? ` near ${prior.place_name}` : '';
    await dmSpotterForReport(
      id,
      `✅ Thanks — your ${hazard} report${place} has been verified by the operator.`,
    );
  }
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

  const hazard = HAZARD_LABEL[report.hazard] ?? 'storm';
  const place = report.place_name ? ` near ${report.place_name}` : '';
  const n = (count as unknown as number) ?? 0;
  await dmSpotterForReport(
    input.id,
    `🚨 Your ${hazard} report${place} has been broadcast to ${n} nearby subscriber${n === 1 ? '' : 's'}. Stay safe.`,
  );

  revalidatePath('/reports');
  revalidatePath('/dashboard');
  return { message_id: msg.id, count: n };
}

export async function promoteReportFromForm(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const body_md = String(formData.get('body_md') ?? '');
  const radius_km = Number(formData.get('radius_km') ?? 25);
  const { message_id } = await promoteReport({ id, body_md, radius_km });
  redirect(`/m/${message_id}`);
}

const HAZARD_FORWARD_HEAD: Record<string, string> = {
  tornado: '🌪 Possible tornado',
  funnel: '🌀 Funnel cloud',
  wind: '💨 Damaging wind',
  hail: '🧊 Hail',
  flood: '🌊 Flooding',
  other: '⚠️ Severe weather',
};

/** Forward a spotter's photo to subscribers within `radius_km`. Inserts a
 *  `messages` row with media_url=photo + a short caption and enqueues via
 *  the standard fanout path — the send-worker handles sendPhoto delivery.
 *  Distinct from promoteReport because the goal is FYI ("here's what a
 *  spotter saw"), not a shelter call to action. */
export async function forwardReportToNearby(input: {
  id: string;
  radius_km?: number;
}): Promise<{ message_id: string; count: number }> {
  const { userId } = await requireOperator();
  const supa = supabaseServer();
  const admin = supabaseAdmin();

  const { data: report } = await supa
    .from('telegram_storm_reports')
    .select('id, lat, lon, hazard, place_name, photo_url, reported_at')
    .eq('id', input.id)
    .maybeSingle();
  if (!report) throw new Error('report not found');
  if (!report.photo_url) throw new Error('report has no photo to forward');

  const radiusKm = Math.max(1, Math.min(50, Math.round(input.radius_km ?? 5)));
  const head = HAZARD_FORWARD_HEAD[report.hazard] ?? '📷 Spotter photo';
  const place = report.place_name ? ` near ${report.place_name}` : ` near your area`;
  const when = new Date(report.reported_at).toLocaleString([], {
    hour: 'numeric', minute: '2-digit',
  });
  const caption =
    `${head} — spotter photo from${place}, reported at ${when}. ` +
    `Stay weather-aware. This is informational; if you are in danger, call 911.`;

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
      body_md: caption,
      body_rendered: caption,
      source: 'manual',
      status: 'draft',
      audience_spec: audienceSpec,
      media_url: report.photo_url,
      media_type: 'photo',
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

  await admin.rpc('record_storm_report_forward', {
    p_report_id: input.id,
    p_message_id: msg.id,
  });

  const n = (count as unknown as number) ?? 0;
  await dmSpotterForReport(
    input.id,
    `📷 Your photo has been forwarded to ${n} nearby subscriber${n === 1 ? '' : 's'} so they know what's happening. Thanks for spotting.`,
  );

  revalidatePath('/reports');
  revalidatePath('/dashboard');
  return { message_id: msg.id, count: n };
}
