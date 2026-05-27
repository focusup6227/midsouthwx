import { supabaseServer } from '@/lib/supabase/server';

// Defense-in-depth on top of RLS: every operator-only server action should call
// this before any mutation so we don't rely solely on RLS rejecting writes.
// Returns the same RLS-respecting server client so callers can use it directly.
export async function requireOperator() {
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user) throw new Error('not authenticated');
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userRes.user.id)
    .maybeSingle();
  if (!op) throw new Error('operators only');
  return supa;
}
