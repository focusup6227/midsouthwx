// Public signup Edge Function.
// Anyone on the public form posts here. We rate-limit by IP (5/hour),
// geocode the ZIP to county_fips, insert the subscriber with status='pending',
// and return the t.me deep link they open to complete /start handshake.

import { serviceClient, json } from './_shared/supabase.ts';

type SignupBody = {
  display_name: string;
  zip: string;
  email?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lng?: number;
};

function bad(message: string, status = 400) {
  return json({ ok: false, error: message }, status);
}

// ZIP → county FIPS via the free Census geocoder. Cached server-side later (v2);
// for v1 we hit it on each signup.
async function zipToCountyFips(zip: string): Promise<string | null> {
  try {
    const url =
      `https://geocoding.geo.census.gov/geocoder/geographies/address` +
      `?street=&city=&state=&zip=${encodeURIComponent(zip)}` +
      `&benchmark=Public_AR_Current&vintage=Current_Current&format=json&layers=Counties`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const matches = data?.result?.addressMatches ?? [];
    const counties = matches[0]?.geographies?.Counties ?? [];
    const geoid = counties[0]?.GEOID;
    return typeof geoid === 'string' ? geoid : null;
  } catch {
    return null;
  }
}

function randomLinkToken() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }
  if (req.method !== 'POST') return bad('POST only', 405);

  let body: SignupBody;
  try {
    body = await req.json();
  } catch {
    return bad('invalid json');
  }

  const { display_name, zip, email, phone, address, lat, lng } = body;
  if (!display_name?.trim()) return bad('display_name required');
  if (!/^\d{5}(-\d{4})?$/.test(zip || '')) return bad('zip must be 5 digits');

  const ip =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';

  const supa = serviceClient();

  // Throttle: 5 signups/hour/IP.
  const { data: throttle, error: throttleErr } = await supa.rpc(
    'try_signup_attempt',
    { p_ip: ip },
  );
  if (throttleErr) {
    console.error('throttle rpc failed', throttleErr);
    return bad('signup unavailable', 500);
  }
  const row = Array.isArray(throttle) ? throttle[0] : throttle;
  if (row && row.allowed === false) {
    return bad('too many signups from this IP — try again in an hour', 429);
  }

  const fips = await zipToCountyFips(zip);
  const link_token = randomLinkToken();
  const link_expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const insert: Record<string, unknown> = {
    display_name: display_name.trim(),
    zip,
    county_fips: fips,
    email: email?.trim() || null,
    phone: phone?.trim() || null,
    home_address: address?.trim() || null,
    status: 'pending',
    link_token,
    link_expires_at,
  };
  if (typeof lat === 'number' && typeof lng === 'number') {
    insert.location = `SRID=4326;POINT(${lng} ${lat})`;
  }

  const { error } = await supa.from('subscribers').insert(insert);
  if (error) {
    console.error('subscribers insert failed', error);
    return bad('signup failed', 500);
  }

  const botUsername =
    Deno.env.get('TELEGRAM_BOT_USERNAME') ?? 'midsouthwxbot';
  const deeplink = `https://t.me/${botUsername}?start=${link_token}`;

  return json({ ok: true, deeplink, expires_at: link_expires_at });
});
