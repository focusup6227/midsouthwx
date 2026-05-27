'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { requireOperator } from '@/lib/auth/require-operator';

const Kind = z.enum(['county', 'zone', 'custom_polygon']);

const RegionInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: Kind,
    county_fips: z.string().trim().max(10),
    ugc_code: z.string().trim().max(20),
    geojson: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'county' && !v.county_fips) {
      ctx.addIssue({ code: 'custom', message: 'county_fips required for county', path: ['county_fips'] });
    }
    if (v.kind === 'zone' && !v.ugc_code) {
      ctx.addIssue({ code: 'custom', message: 'ugc_code required for zone', path: ['ugc_code'] });
    }
    if (v.kind === 'custom_polygon' && !v.geojson) {
      ctx.addIssue({ code: 'custom', message: 'geojson required for custom_polygon', path: ['geojson'] });
    }
    if (v.geojson) {
      try {
        JSON.parse(v.geojson);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'geojson is not valid JSON', path: ['geojson'] });
      }
    }
  });

function readInput(formData: FormData) {
  const parsed = RegionInput.safeParse({
    name: String(formData.get('name') ?? ''),
    kind: String(formData.get('kind') ?? ''),
    county_fips: String(formData.get('county_fips') ?? ''),
    ugc_code: String(formData.get('ugc_code') ?? ''),
    geojson: String(formData.get('geojson') ?? ''),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${first.path.join('.') || 'input'}: ${first.message}`);
  }
  return parsed.data;
}

function geojsonForRpc(raw: string): string | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (parsed?.type === 'Feature' && parsed.geometry) {
    return JSON.stringify(parsed.geometry);
  }
  if (parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features) && parsed.features.length === 1) {
    return JSON.stringify(parsed.features[0].geometry);
  }
  return JSON.stringify(parsed);
}

export async function createRegion(formData: FormData): Promise<void> {
  await requireOperator();
  const input = readInput(formData);
  const admin = supabaseAdmin();
  const { error } = await admin.rpc('upsert_region_geojson', {
    p_name: input.name,
    p_kind: input.kind,
    p_county_fips: input.county_fips || null,
    p_ugc_code: input.ugc_code || null,
    p_geojson: geojsonForRpc(input.geojson),
  });
  if (error) throw new Error(error.message);
  revalidatePath('/regions');
  redirect('/regions');
}

export async function updateRegion(formData: FormData): Promise<void> {
  const idParse = z.string().uuid().safeParse(String(formData.get('id') ?? ''));
  if (!idParse.success) throw new Error('invalid region id');
  const input = readInput(formData);

  const supa = await requireOperator();
  const updates: Record<string, unknown> = {
    name: input.name,
    kind: input.kind,
    county_fips: input.county_fips || null,
    ugc_code: input.ugc_code || null,
  };
  const { error: updErr } = await supa.from('regions').update(updates).eq('id', idParse.data);
  if (updErr) throw new Error(updErr.message);

  if (input.geojson) {
    const admin = supabaseAdmin();
    const { error: rpcErr } = await admin.rpc('upsert_region_geojson', {
      p_name: input.name,
      p_kind: input.kind,
      p_county_fips: input.county_fips || null,
      p_ugc_code: input.ugc_code || null,
      p_geojson: geojsonForRpc(input.geojson),
    });
    if (rpcErr) throw new Error(rpcErr.message);
  }

  revalidatePath('/regions');
  redirect('/regions');
}

export async function deleteRegion(formData: FormData): Promise<void> {
  const idParse = z.string().uuid().safeParse(String(formData.get('id') ?? ''));
  if (!idParse.success) throw new Error('invalid region id');
  const id = idParse.data;

  const supa = await requireOperator();
  const { data: rules } = await supa
    .from('auto_alert_rules')
    .select('id, region_filter')
    .not('region_filter', 'is', null);
  const ruleHit = (rules ?? []).find((r) => {
    const ids = (r.region_filter as { region_ids?: string[] } | null)?.region_ids ?? [];
    return ids.includes(id);
  });
  if (ruleHit) {
    throw new Error('Region is referenced by an NWS auto-alert rule. Edit the rule first.');
  }

  const { data: scheds } = await supa
    .from('scheduled_messages')
    .select('id, audience_spec')
    .in('status', ['pending', 'failed']);
  const schedHit = (scheds ?? []).find((s) => {
    const ids = (s.audience_spec as { regions?: string[] } | null)?.regions ?? [];
    return ids.includes(id);
  });
  if (schedHit) {
    throw new Error('Region is referenced by a pending scheduled alert. Edit or cancel the schedule first.');
  }

  const { error } = await supa.from('regions').delete().eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/regions');
}
