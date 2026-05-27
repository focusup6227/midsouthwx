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
    // home_location is the snapshot used by /home to revert when the
    // subscriber returns from a trip.
    const wkt = `SRID=4326;POINT(${geo.lng} ${geo.lat})`;
    insertRow.location = wkt;
    insertRow.home_location = wkt;
    insertRow.home_location_updated_at = new Date().toISOString();
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

  const subject = "You're invited to MidSouthWX severe weather alerts";
  const introName = parsed.data.display_name.split(' ')[0] || 'there';
  // Inboxes can only load images via absolute HTTPS, so the brand mark is
  // suppressed when NEXT_PUBLIC_SITE_URL isn't configured (dev/local).
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '');
  const logoBlock = siteUrl
    ? `<img src="${siteUrl}/icons/icon-192.png" alt="MidSouthWX" width="72" height="72" style="display:inline-block;border-radius:50%;border:0" />`
    : '';
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td align="center" style="background:#0b1220;padding:24px 24px 20px;">
            ${logoBlock}
            <div style="color:#f8fafc;font-size:18px;font-weight:600;margin-top:${logoBlock ? '12px' : '0'};letter-spacing:0.02em;">MidSouthWX</div>
            <div style="color:#94a3b8;font-size:11px;margin-top:4px;text-transform:uppercase;letter-spacing:0.08em;">Severe weather alerts</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;line-height:1.5;">
            <p style="margin:0 0 12px;">Hi ${escapeHtml(introName)},</p>
            <p style="margin:0 0 12px;">You've been invited to receive severe-weather alerts for ZIP ${escapeHtml(parsed.data.zip)}. Alerts arrive as Telegram messages — tornado warnings, severe thunderstorm warnings, flash-flood warnings, and operator-sent updates.</p>
            <p style="margin:24px 0;">
              <a href="${deeplink}" style="display:inline-block;background:#fbbf24;color:#0b1220;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;">
                Open Telegram &amp; activate
              </a>
            </p>
            <p style="color:#555;font-size:13px;margin:0 0 8px;">If the button doesn't open Telegram, copy this link:</p>
            <p style="word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f5f5f5;padding:8px 10px;border-radius:6px;margin:0;">${escapeHtml(deeplink)}</p>
            <p style="color:#777;font-size:12px;margin:24px 0 0;">
              This invite expires in 7 days. If you didn't expect this email, you can safely ignore it — no account is created until you tap Start in Telegram.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = `Hi ${introName},

You've been invited to receive severe-weather alerts for ZIP ${parsed.data.zip} via Telegram.

Open this link in Telegram to activate:
${deeplink}

This invite expires in 7 days.

— MidSouthWX`;

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
