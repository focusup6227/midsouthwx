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
    ? `<img src="${siteUrl}/icons/icon-192.png" width="72" height="72" alt="Mid-South WX" style="display:block;border-radius:50%;border:1px solid #1f2937;" />`
    : '';
  const FONT = `'Segoe UI',Roboto,-apple-system,Helvetica,Arial,sans-serif`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="dark light" />
    <meta name="supported-color-schemes" content="dark light" />
  </head>
  <body style="margin:0; padding:0; width:100%; background-color:#0b1220; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
      Activate your Mid-South WX severe-weather alerts in Telegram.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b1220;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px; max-width:480px; background-color:#111827; border:1px solid #1f2937; border-radius:12px; overflow:hidden;">
            <tr>
              <td align="center" style="padding:36px 36px 8px 36px;">${logoBlock}</td>
            </tr>
            <tr>
              <td align="center" style="padding:0 36px;">
                <p style="margin:${logoBlock ? '14px' : '0'} 0 0 0; font-family:${FONT}; font-size:12px; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:#fbbf24;">Mid-South WX</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:18px 36px 0 36px;">
                <h1 style="margin:0; font-family:${FONT}; font-size:24px; line-height:1.25; font-weight:700; color:#e5e7eb;">Your severe-weather alerts are ready</h1>
              </td>
            </tr>
            <tr>
              <td align="left" style="padding:16px 36px 0 36px;">
                <p style="margin:0 0 14px 0; font-family:${FONT}; font-size:15px; line-height:1.6; color:#94a3b8;">Hi <span style="color:#e5e7eb; font-weight:600;">${escapeHtml(introName)}</span>,</p>
                <p style="margin:0; font-family:${FONT}; font-size:15px; line-height:1.6; color:#94a3b8;">You've been invited to receive severe-weather alerts for ZIP <span style="color:#e5e7eb; font-weight:600;">${escapeHtml(parsed.data.zip)}</span>. Alerts arrive as Telegram messages — tornado warnings, severe thunderstorm warnings, flash-flood warnings, and operator updates. Tap below and press <span style="color:#e5e7eb; font-weight:600;">Start</span> to activate.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 36px 8px 36px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="#fbbf24" style="border-radius:8px;">
                      <a href="${deeplink}" target="_blank" style="display:inline-block; padding:13px 28px; font-family:${FONT}; font-size:15px; font-weight:700; color:#111111; text-decoration:none; border-radius:8px;">Open Telegram &amp; activate</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:14px 36px 0 36px;">
                <p style="margin:0; font-family:${FONT}; font-size:12px; line-height:1.5; color:#64748b;">Button not opening Telegram? Copy and paste this link:</p>
                <p style="margin:6px 0 0 0; font-family:${FONT}; font-size:12px; line-height:1.5; word-break:break-all;"><a href="${deeplink}" target="_blank" style="color:#fbbf24; text-decoration:underline;">${escapeHtml(deeplink)}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 36px 0 36px;">
                <div style="height:1px; line-height:1px; font-size:0; background-color:#1f2937;">&nbsp;</div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:18px 36px 36px 36px;">
                <p style="margin:0; font-family:${FONT}; font-size:12px; line-height:1.6; color:#64748b;">This invite expires in 7 days. If you didn't expect this email, you can safely ignore it — no account is created until you tap Start in Telegram.</p>
              </td>
            </tr>
          </table>
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px; max-width:480px;">
            <tr>
              <td align="center" style="padding:20px 36px 0 36px;">
                <p style="margin:0; font-family:${FONT}; font-size:11px; line-height:1.5; color:#475569;">Mid-South WX · Severe weather alert dashboard</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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
