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

export async function updateOperator(formData: FormData): Promise<{ ok: true } | { error: string }> {
  const display_name = String(formData.get('display_name') ?? '').trim() || null;
  const chatRaw = String(formData.get('telegram_chat_id') ?? '').trim();
  const telegram_chat_id = chatRaw ? Number(chatRaw) : null;
  if (chatRaw && !Number.isFinite(telegram_chat_id)) {
    return { error: 'Telegram chat id must be a number' };
  }

  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return { error: 'Not authenticated' };

  const { error } = await supa
    .from('operators')
    .update({ display_name, telegram_chat_id })
    .eq('user_id', userId);
  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
