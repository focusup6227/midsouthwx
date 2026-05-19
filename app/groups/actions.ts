'use server';

import { supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

export async function createGroup(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  if (!name) throw new Error('Name is required');

  const supa = supabaseServer();
  const { data, error } = await supa
    .from('custom_groups')
    .insert({ name, description })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'insert failed');

  revalidatePath('/groups');
  redirect(`/groups/${data.id}`);
}

export async function deleteGroup(id: string) {
  const supa = supabaseServer();
  const { error } = await supa.from('custom_groups').delete().eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/groups');
  redirect('/groups');
}

export async function addMember(groupId: string, subscriberId: string) {
  const supa = supabaseServer();
  const { error } = await supa
    .from('group_memberships')
    .upsert({ group_id: groupId, subscriber_id: subscriberId });
  if (error) throw new Error(error.message);
  revalidatePath(`/groups/${groupId}`);
}

export async function removeMember(groupId: string, subscriberId: string) {
  const supa = supabaseServer();
  const { error } = await supa
    .from('group_memberships')
    .delete()
    .eq('group_id', groupId)
    .eq('subscriber_id', subscriberId);
  if (error) throw new Error(error.message);
  revalidatePath(`/groups/${groupId}`);
}
