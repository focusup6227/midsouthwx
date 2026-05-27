'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { importCounties, importZones, type ImportResult } from '@/lib/regions/import';

const PayloadSchema = z.object({
  kind: z.enum(['counties', 'zones']),
  states: z.array(z.string().min(1)).min(1).max(56),
});

export async function bulkImportRegions(input: unknown): Promise<{
  ok: boolean;
  results: ImportResult[];
  error?: string;
}> {
  const parsed = PayloadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, results: [], error: parsed.error.message };
  }

  const admin = supabaseAdmin();
  const ua = process.env.NWS_USER_AGENT ?? '';

  const upsert = async (row: {
    name: string;
    kind: 'county' | 'zone';
    county_fips: string | null;
    ugc_code: string | null;
    geojson: string;
  }) => {
    const { error } = await admin.rpc('upsert_region_geojson', {
      p_name: row.name,
      p_kind: row.kind,
      p_county_fips: row.county_fips,
      p_ugc_code: row.ugc_code,
      p_geojson: row.geojson,
    });
    if (error) throw new Error(error.message);
  };

  const results: ImportResult[] = [];
  for (const state of parsed.data.states) {
    if (parsed.data.kind === 'counties') {
      results.push(await importCounties(state, upsert));
    } else {
      results.push(await importZones(state, ua, upsert));
    }
  }

  revalidatePath('/regions');
  return { ok: true, results };
}
