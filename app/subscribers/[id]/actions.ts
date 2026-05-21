'use server';

import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { geocodeSubscriber } from '@/lib/geocode';

type Status = 'pending' | 'active' | 'paused' | 'unsubscribed';

async function setStatus(id: string, status: Status) {
  const supa = supabaseServer();
  const { error } = await supa.from('subscribers').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/subscribers');
  revalidatePath(`/subscribers/${id}`);
}

export async function pauseSubscriber(id: string) {
  await setStatus(id, 'paused');
}

export async function resumeSubscriber(id: string) {
  await setStatus(id, 'active');
}

export async function unsubscribeSubscriber(id: string) {
  await setStatus(id, 'unsubscribed');
}

export type RefreshLocationResult =
  | {
      ok: true;
      lat: number;
      lng: number;
      countyFips: string | null;
      source: 'address' | 'zip';
      matchedAddress?: string;
    }
  | { ok: false; error: string };

// Re-geocodes a subscriber from their home_address (preferred — rooftop
// precision) or ZIP (centroid fallback). Updates subscribers.location and
// county_fips; the PostGIS trigger then re-derives subscriber_regions so
// polygon-based audience matching works correctly.
//
// Idempotent: safe to call repeatedly. Uses the admin client so it works
// even on rows whose trigger functions require service_role.
export async function refreshSubscriberLocation(id: string): Promise<RefreshLocationResult> {
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  if (!userRes.user) return { ok: false, error: 'Not signed in.' };
  const { data: op } = await supa
    .from('operators')
    .select('user_id')
    .eq('user_id', userRes.user.id)
    .maybeSingle();
  if (!op) return { ok: false, error: 'Operators only.' };

  const admin = supabaseAdmin();
  const { data: sub, error: readErr } = await admin
    .from('subscribers')
    .select('id, home_address, zip')
    .eq('id', id)
    .single();
  if (readErr || !sub) return { ok: false, error: 'Subscriber not found.' };
  if (!sub.home_address && !sub.zip) {
    return { ok: false, error: 'No address or ZIP on file to geocode.' };
  }

  const geo = await geocodeSubscriber({
    address: sub.home_address,
    zip: sub.zip,
  });
  if (!geo) {
    return {
      ok: false,
      error: 'Geocoding failed — both address and ZIP lookups came up empty.',
    };
  }

  const { error: updErr } = await admin
    .from('subscribers')
    .update({
      location: `SRID=4326;POINT(${geo.lng} ${geo.lat})`,
      county_fips: geo.countyFips,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath(`/subscribers/${id}`);
  revalidatePath('/subscribers');

  return {
    ok: true,
    lat: geo.lat,
    lng: geo.lng,
    countyFips: geo.countyFips,
    source: geo.source,
    matchedAddress: geo.matchedAddress,
  };
}
