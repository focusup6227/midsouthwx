'use server';

import { supabaseServer } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function markRead(convId: string) {
  const supa = supabaseServer();
  const { error } = await supa.rpc('mark_conversation_read', { conv_id: convId });
  if (error) throw new Error(error.message);
  revalidatePath('/inbox');
  revalidatePath(`/inbox/${convId}`);
}
