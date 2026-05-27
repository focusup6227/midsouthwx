'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import type { InviteOperatorState } from './invite-state';

export type { InviteOperatorState } from './invite-state';

const emailSchema = z.string().trim().email();

function inviteRedirectBase(): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '');
  if (env) return env;

  const h = headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = (h.get('x-forwarded-proto') ?? 'https').split(',')[0]?.trim() ?? 'https';
  if (host) return `${proto}://${host}`;

  throw new Error(
    'Set NEXT_PUBLIC_SITE_URL to your public site URL so invite emails use a valid redirect.',
  );
}

export async function inviteOperatorAction(
  _prev: InviteOperatorState,
  formData: FormData,
): Promise<InviteOperatorState> {
  const parsed = emailSchema.safeParse(String(formData.get('email') ?? ''));
  if (!parsed.success) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  const email = parsed.data.toLowerCase();

  const supa = supabaseServer();
  const { data: userRes, error: userErr } = await supa.auth.getUser();
  if (userErr || !userRes.user) {
    return { ok: false, error: 'You must be signed in to send invites.' };
  }

  const { data: opRow } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userRes.user.id)
    .maybeSingle();

  if (!opRow) {
    return { ok: false, error: 'Only operators can invite other operators.' };
  }

  let redirectTo: string;
  try {
    const base = inviteRedirectBase();
    redirectTo = `${base}/auth/callback?next=${encodeURIComponent('/dashboard')}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invite redirect is not configured.';
    return { ok: false, error: msg };
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
  });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('already registered') || msg.includes('already been registered')) {
      return {
        ok: false,
        error: 'That email already has an account. They can sign in from the login page.',
      };
    }
    if (msg.includes('invalid')) {
      return { ok: false, error: error.message };
    }
    console.error('[inviteOperator]', error);
    return { ok: false, error: error.message || 'Could not send invite. Check Supabase Auth settings.' };
  }

  if (data.user?.id) {
    const { error: opErr } = await admin.from('operators').upsert(
      { user_id: data.user.id, display_name: email },
      { onConflict: 'user_id' },
    );
    if (opErr) {
      console.error('[inviteOperator] operator upsert', opErr);
      return {
        ok: false,
        error: 'Invite was sent, but the operator row could not be created. Check migrations and retry.',
      };
    }
  }

  return { ok: true, error: null };
}
