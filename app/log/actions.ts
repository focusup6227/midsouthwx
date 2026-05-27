'use server';

import { revalidatePath } from 'next/cache';
import { supabaseServer } from '@/lib/supabase/server';

// F14: server actions for the operator event log. RLS gates inserts to
// operators; we set `created_by` explicitly from auth.uid() so the column
// reflects who authored a note even if it's later edited by another
// operator (multi-operator setups are rare today but the schema is ready).

export type AddEntryInput = {
  body: string;
  tags: string[];
  severity: 'info' | 'warning' | 'critical';
  occurred_at?: string;
  point?: { lon: number; lat: number } | null;
  refs?: Record<string, unknown>;
};

const MAX_BODY = 2000;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 48;

export async function addLogEntry(input: AddEntryInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return { ok: false, error: 'not authenticated' };

  const body = input.body.trim().slice(0, MAX_BODY);
  if (!body) return { ok: false, error: 'body required' };

  // Tags: lowercase, trim, dedupe, cap length + count. Keeps the index
  // small and the export stable.
  const tags = Array.from(new Set(
    (input.tags ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t && t.length <= MAX_TAG_LEN),
  )).slice(0, MAX_TAGS);

  const severity = input.severity ?? 'info';

  // PostGIS uses the EWKT `SRID=4326;POINT(lon lat)` form for geography
  // inserts via the REST API; using ST_MakePoint via an RPC would be
  // cleaner but adds a round trip for the common no-location case.
  const pointWkt = input.point
    ? `SRID=4326;POINT(${input.point.lon} ${input.point.lat})`
    : null;

  const { data, error } = await supa
    .from('event_log_entries')
    .insert({
      body,
      tags,
      severity,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      created_by: userId,
      point: pointWkt as unknown,
      refs: input.refs ?? {},
    })
    .select('id')
    .single();

  if (error) {
    console.error('[event-log] insert', error.message);
    return { ok: false, error: error.message };
  }
  revalidatePath('/log');
  return { ok: true, id: data.id as string };
}

export async function deleteLogEntry(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: 'invalid id' };
  const supa = supabaseServer();
  const { error } = await supa.from('event_log_entries').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/log');
  return { ok: true };
}
