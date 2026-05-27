// Per-subscriber conversational state helpers. Used by the bot to remember
// "the next plain-text message from this user should be treated as an
// address" (or quiet-hour time, or anything else guided).
//
// Each `awaiting` value names a single flow. The webhook checks state BEFORE
// treating an incoming message as a chat reply, so multi-step flows feel
// natural ("tap a button → reply with the value → bot confirms").

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export type AwaitingKind =
  | 'address'         // /where: subscriber is replying with an address to geocode
  | 'address_ttl'     // /where ... for N hours: subscriber is replying with hours
  | 'quiet_start'     // editable quiet hours
  | 'quiet_end'
  | 'quiet_tz';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function setAwaiting(
  supa: SupabaseClient,
  subscriberId: string,
  awaiting: AwaitingKind,
  meta: Record<string, unknown> = {},
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  const expires = new Date(Date.now() + ttlMs).toISOString();
  await supa
    .from('subscriber_states')
    .upsert(
      {
        subscriber_id: subscriberId,
        awaiting,
        meta,
        expires_at: expires,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'subscriber_id' },
    );
}

export async function clearAwaiting(
  supa: SupabaseClient,
  subscriberId: string,
): Promise<void> {
  await supa
    .from('subscriber_states')
    .upsert(
      {
        subscriber_id: subscriberId,
        awaiting: null,
        meta: {},
        expires_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'subscriber_id' },
    );
}

export type AwaitingRow = {
  awaiting: AwaitingKind | null;
  meta: Record<string, unknown>;
};

/** Returns the active awaiting flow, or null if none/expired. Auto-clears
 *  expired rows so the next message isn't surprised by stale state. */
export async function getAwaiting(
  supa: SupabaseClient,
  subscriberId: string,
): Promise<AwaitingRow | null> {
  const { data } = await supa
    .from('subscriber_states')
    .select('awaiting, meta, expires_at')
    .eq('subscriber_id', subscriberId)
    .maybeSingle();
  if (!data?.awaiting) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    await clearAwaiting(supa, subscriberId);
    return null;
  }
  return {
    awaiting: data.awaiting as AwaitingKind,
    meta: (data.meta ?? {}) as Record<string, unknown>,
  };
}
