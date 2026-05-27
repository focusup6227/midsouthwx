'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOperator } from '@/lib/auth/require-operator';

const QuickReply = z.object({ label: z.string().min(1), data: z.string().min(1) });

function parseQuickReplies(raw: string): { label: string; data: string }[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const arr = z.array(QuickReply).safeParse(parsed);
    if (!arr.success) throw new Error('Invalid quick replies JSON');
    return arr.data;
  } catch {
    throw new Error('Quick replies must be valid JSON array');
  }
}

function parseTemplateForm(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  const category = String(formData.get('category') ?? '').trim();
  const body_md = String(formData.get('body_md') ?? '').trim();
  const quickRepliesRaw = String(formData.get('quick_replies_json') ?? '').trim();
  if (!name || !body_md) throw new Error('Name and body are required');
  return {
    name,
    category: category || null,
    body_md,
    default_quick_replies: parseQuickReplies(quickRepliesRaw),
  };
}

export async function createTemplate(formData: FormData): Promise<void> {
  const supa = await requireOperator();
  const row = parseTemplateForm(formData);
  const { error } = await supa.from('templates').insert(row);
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
  revalidatePath('/compose');
  revalidatePath('/schedule');
}

export async function updateTemplate(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (!z.string().uuid().safeParse(id).success) throw new Error('Invalid template id');

  const supa = await requireOperator();
  const row = parseTemplateForm(formData);
  const { error } = await supa.from('templates').update(row).eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
  revalidatePath('/compose');
  revalidatePath('/schedule');
}

export async function deleteTemplate(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (!z.string().uuid().safeParse(id).success) throw new Error('Invalid template id');

  const supa = await requireOperator();
  const { error } = await supa.from('templates').delete().eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/settings');
  revalidatePath('/compose');
  revalidatePath('/schedule');
}
