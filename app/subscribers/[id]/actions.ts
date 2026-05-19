'use server';

import { supabaseServer } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

type Status = 'pending' | 'active' | 'paused' | 'unsubscribed';

async function setStatus(id: string, status: Status) {
  const supa = supabaseServer();
  const { error } = await supa.from('subscribers').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/subscribers');
  revalidatePath(`/subscribers/${id}`);
}

export async function pauseSubscriber(id: string) {
  await setStatus(id, 'paused');
}

export async function resumeSubscriber(id: string) {
  await setStatus(id, 'active');
}

export async function unsubscribeSubscriber(id: string) {
  await setStatus(id, 'unsubscribed');
}
