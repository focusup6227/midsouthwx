'use server';

import { revalidatePath } from 'next/cache';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email';
import { geocodeSubscriber } from '@/lib/geocode';
import type { InviteSubscriberState } from './invite-state';

const Schema = z.object({
  display_name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Valid email is required').max(254),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 5 digits'),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
});

function fail(error: string): InviteSubscriberState {
  return { kind: 'error', error };
}

export async function inviteSubscriberAction(
  _prev: InviteSubscriberState,
  formData: FormData,
): Promise<InviteSubscriberState> {
  // Operator auth check — only operators can invite.
  const supa = supabaseServer();
  const { data: userRes, error: userErr } = await supa.auth.getUser();
  if (userErr || !userRes.user) {
    return fail('You must be signed in.');
  }
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userRes.user.id)
    .maybeSingle();
  if (!op) return fail('Only operators can invite subscribers.');

  const parsed = Schema.safeParse({
    display_name: formData.get('display_name') ?? '',
    email: formData.get('email') ?? '',
    zip: formData.get('zip') ?? '',
    address: formData.get('address') ?? '',
    phone: formData.get('phone') ?? '',
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? 'Invalid input.');
  }

  const admin = supabaseAdmin();

  // Reject duplicate-email pending invites so the operator doesn't accidentally
  // spam someone with two open tokens. Active subs keep working — they can be
  // re-invited if needed (we surface that case explicitly below).
  const { data: existing } = await admin
    .from('subscribers')
    .select('id, status, email')
    .eq('email', parsed.data.email)
    .maybeSingle();

  if (existing && existing.status === 'pending') {
    return fail(
      'That email already has a pending invite. Check the subscribers list and resend from there if needed.',
    );
  }
  if (existing && existing.status === 'active') {
    return fail(
      'That email is already an active subscriber. Open their profile if you need to make changes.',
    );
  }

  const geo = await geocodeSubscriber({
    address: parsed.data.address || null,
    zip: parsed.data.zip,
  });
  const linkToken = randomBytes(16).toString('hex');
  // 7-day expiry — longer than the public signup form so the operator has time
  // to follow up (text/call) if the invitee doesn't click the email immediately.
  const linkExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const insertRow: Record<string, unknown> = {
    display_name: parsed.data.display_name,
    email: parsed.data.email,
    zip: parsed.data.zip,
    county_fips: geo?.countyFips ?? null,
    status: 'pending',
    link_token: linkToken,
    link_expires_at: linkExpiresAt,
  };
  if (geo) {
    // Address-precise when we have it, ZIP centroid otherwise. Subscribers
    // can override via Telegram /where <address> if they ever leave home.
    insertRow.location = `SRID=4326;POINT(${geo.lng} ${geo.lat})`;
  }
  if (parsed.data.phone) insertRow.phone = parsed.data.phone;
  // The signup function uses `home_address`; older migrations may name it differently
  // — only set if provided to avoid breaking on schemas that lack the column.
  if (parsed.data.address) insertRow.home_address = parsed.data.address;

  const { error: insErr } = await admin.from('subscribers').insert(insertRow);
  if (insErr) {
    // home_address may not exist in the deployed schema. Retry without it.
    if (insErr.message?.includes('home_address')) {
      delete insertRow.home_address;
      const { error: retryErr } = await admin.from('subscribers').insert(insertRow);
      if (retryErr) return fail(retryErr.message);
    } else {
      return fail(insErr.message);
    }
  }

  const botUsername =
    process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? 'midsouthwxbot';
  const deeplink = `https://t.me/${botUsername}?start=${linkToken}`;

  const subject = "You're invited to Mid-South WX severe weather alerts";
  const introName = parsed.data.display_name.split(' ')[0] || 'there';
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #111; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 22px; margin: 0 0 16px;">Mid-South WX</h1>
  <p>Hi ${escapeHtml(introName)},</p>
  <p>You've been invited to receive severe-weather alerts for ZIP ${escapeHtml(parsed.data.zip)}. Alerts arrive as Telegram messages — tornado warnings, severe thunderstorm warnings, flash-flood warnings, and operator-sent updates.</p>
  <p style="margin: 24px 0;">
    <a href="${deeplink}" style="display: inline-block; background: #f59e0b; color: #000; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Open Telegram &amp; activate
    </a>
  </p>
  <p style="color: #555; font-size: 13px;">If the button doesn't open Telegram, copy this link:</p>
  <p style="word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f5f5f5; padding: 8px 10px; border-radius: 6px;">${escapeHtml(deeplink)}</p>
  <p style="color: #777; font-size: 12px; margin-top: 24px;">
    This invite expires in 7 days. If you didn't expect this email, you can safely ignore it — no account is created until you tap Start in Telegram.
  </p>
</body></html>`;
  const text = `Hi ${introName},

You've been invited to receive severe-weather alerts for ZIP ${parsed.data.zip} via Telegram.

Open this link in Telegram to activate:
${deeplink}

This invite expires in 7 days.`;

  const emailRes = await sendEmail({
    to: parsed.data.email,
    subject,
    html,
    text,
  });

  revalidatePath('/subscribers');

  return {
    kind: 'success',
    deeplink,
    expiresAt: linkExpiresAt,
    displayName: parsed.data.display_name,
    email: parsed.data.email,
    emailStatus: emailRes.sent
      ? 'sent'
      : emailRes.reason === 'unconfigured'
        ? 'unconfigured'
        : 'failed',
    emailError: emailRes.sent ? undefined : emailRes.reason === 'failed' ? emailRes.error : undefined,
  };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
