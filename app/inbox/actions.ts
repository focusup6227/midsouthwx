'use server';

import { revalidatePath } from 'next/cache';
import { supabaseServer } from '@/lib/supabase/server';

/** Clear every unread conversation in one click — mirrors mark_conversation_read. */
export async function markAllConversationsRead(): Promise<{ ok: true; cleared: number } | { error: string }> {
  const supa = supabaseServer();

  const { data: unread, error: listErr } = await supa
    .from('conversations')
    .select('id')
    .gt('unread_count', 0);
  if (listErr) return { error: listErr.message };
  if (!unread?.length) return { ok: true, cleared: 0 };

  const ids = unread.map((c) => c.id);
  const { error: repliesErr } = await supa
    .from('replies')
    .update({ read_at: new Date().toISOString() })
    .in('conversation_id', ids)
    .is('read_at', null)
    .eq('direction', 'inbound');
  if (repliesErr) return { error: repliesErr.message };

  const { error: convErr } = await supa
    .from('conversations')
    .update({ unread_count: 0 })
    .in('id', ids);
  if (convErr) return { error: convErr.message };

  revalidatePath('/inbox');
  return { ok: true, cleared: ids.length };
}
