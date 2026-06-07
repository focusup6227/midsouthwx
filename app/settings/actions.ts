'use server';

import { supabaseServer } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function setPassword(formData: FormData): Promise<{ ok: true } | { error: string }> {
  const password = String(formData.get('password') ?? '');
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters' };
  }

  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user) return { error: 'not authenticated' };

  const { error } = await supa.auth.updateUser({ password });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function updateOperator(formData: FormData) {
  const display_name = String(formData.get('display_name') ?? '').trim() || null;
  const chatRaw = String(formData.get('telegram_chat_id') ?? '').trim();
  const telegram_chat_id = chatRaw ? Number(chatRaw) : null;
  if (chatRaw && !Number.isFinite(telegram_chat_id)) {
    throw new Error('telegram_chat_id must be a number');
  }

  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) throw new Error('not authenticated');

  const { error } = await supa
    .from('operators')
    .update({ display_name, telegram_chat_id })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);

  revalidatePath('/settings');
}

export async function updateBriefingFocus(formData: FormData) {
  const label = String(formData.get('focus_label') ?? '').trim() || 'Focus area';
  const lat = Number(String(formData.get('focus_lat') ?? '').trim());
  const lon = Number(String(formData.get('focus_lon') ?? '').trim());
  const radius = Number(String(formData.get('focus_radius_mi') ?? '').trim());

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('Center latitude must be between -90 and 90');
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error('Center longitude must be between -180 and 180');
  }
  if (!Number.isFinite(radius) || radius < 10 || radius > 1000) {
    throw new Error('Radius must be between 10 and 1000 miles');
  }

  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user) throw new Error('not authenticated');

  const { error } = await supa
    .from('app_settings')
    .update({
      briefing_focus_label: label,
      briefing_focus_lat: lat,
      briefing_focus_lon: lon,
      briefing_focus_radius_mi: radius,
      updated_at: new Date().toISOString(),
    })
    .eq('id', true);
  if (error) throw new Error(error.message);

  revalidatePath('/settings');
  revalidatePath('/briefing');
}
