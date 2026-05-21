'use server';

import { revalidatePath } from 'next/cache';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email';
import type { InviteSubscriberState } from './invite-state';

const Schema = z.object({
  display_name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Valid email is required').max(254),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 5 digits'),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
});

type ZipLookup = {
  lat: number;
  lng: number;
  city: string | null;
  state: string | null;
  countyFips: string | null;
};

// ZIP → lat/lng/city/state via zippopotam.us (free, no key, no rate limit
// at this scale). Then lat/lng → county FIPS via NWS /points (we already
// require NWS_USER_AGENT for the alert poller). Either step can fail
// gracefully — `location` alone is enough for polygon-based audience
// matching against the seeded `regions` table.
async function lookupZip(zip: string): Promise<ZipLookup | null> {
  let lat: number | null = null;
  let lng: number | null = null;
  let city: string | null = null;
  let state: string | null = null;
  try {
    // Strip ZIP+4 down to the 5-digit prefix; zippopotam wants 5 digits.
    const z5 = zip.slice(0, 5);
    const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(z5)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.ok) {
      const data = (await res.json()) as {
        places?: Array<{
          latitude?: string;
          longitude?: string;
          'place name'?: string;
          'state abbreviation'?: string;
        }>;
      };
      const place = data.places?.[0];
      if (place) {
        const plat = Number(place.latitude);
        const plng = Number(place.longitude);
        if (Number.isFinite(plat) && Number.isFinite(plng)) {
          lat = plat;
          lng = plng;
        }
        city = place['place name'] ?? null;
        state = place['state abbreviation'] ?? null;
      }
    }
  } catch {
    // zippopotam down — fall through with nulls.
  }

  if (lat === null || lng === null) return null;

  let countyFips: string | null = null;
  try {
    const ua = process.env.NWS_USER_AGENT ?? 'midsouthwx';
    const r = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
      {
        headers: { 'user-agent': ua, accept: 'application/geo+json' },
        cache: 'no-store',
      },
    );
    if (r.ok) {
      const d = (await r.json()) as {
        properties?: { county?: string };
      };
      // properties.county is a URL like https://api.weather.gov/zones/county/TNC157
      // — last 3 chars after the state letter are the county FIPS suffix.
      // Combine with the state FIPS to get the 5-digit GEOID.
      const url = d.properties?.county;
      if (url) {
        const m = url.match(/\/county\/([A-Z]{2})([A-Z])(\d{3})$/);
        if (m) {
          const stateAbbr = m[1];
          const countySuffix = m[3];
          const stateFips = STATE_ABBR_TO_FIPS[stateAbbr];
          if (stateFips) countyFips = `${stateFips}${countySuffix}`;
        }
      }
    }
  } catch {
    // NWS down — that's ok, polygon match via location still works.
  }

  return { lat, lng, city, state, countyFips };
}

const STATE_ABBR_TO_FIPS: Record<string, string> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09',
  DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17',
  IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31',
  NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38',
  OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46',
  TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
  WI: '55', WY: '56', PR: '72',
};

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

  const zipInfo = await lookupZip(parsed.data.zip);
  const linkToken = randomBytes(16).toString('hex');
  // 7-day expiry — longer than the public signup form so the operator has time
  // to follow up (text/call) if the invitee doesn't click the email immediately.
  const linkExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const insertRow: Record<string, unknown> = {
    display_name: parsed.data.display_name,
    email: parsed.data.email,
    zip: parsed.data.zip,
    county_fips: zipInfo?.countyFips ?? null,
    status: 'pending',
    link_token: linkToken,
    link_expires_at: linkExpiresAt,
  };
  if (zipInfo) {
    // ZIP centroid is precise enough for storm-polygon matching; subscribers
    // can refine via Telegram /where <address> later.
    insertRow.location = `SRID=4326;POINT(${zipInfo.lng} ${zipInfo.lat})`;
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
