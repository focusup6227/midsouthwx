'use server';

import { supabaseServer } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const TemplateInput = z.object({
  // Seed a template from an existing forecast — copies area + hazards so the
  // operator doesn't have to redraw.
  source_forecast_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  cadence: z.enum(['daily', 'weekly']),
  hour_of_day: z.number().int().min(0).max(23),
  window_hours: z.number().int().min(1).max(168),
});

export async function createForecastTemplateFromForecast(
  input: z.infer<typeof TemplateInput>,
): Promise<{ id: string }> {
  const parsed = TemplateInput.parse(input);
  const supa = supabaseServer();

  const { data: src, error: serr } = await supa
    .from('forecasts')
    .select('id, hazards, confidence')
    .eq('id', parsed.source_forecast_id)
    .maybeSingle();
  if (serr || !src) throw new Error(serr?.message ?? 'source forecast not found');

  // Pull the forecast area back as GeoJSON; the templates table stores
  // geography, so we round-trip via the same RPC the form uses.
  const { data: areaJson, error: aerr } = await supa.rpc('forecast_area_geojson', {
    p_id: parsed.source_forecast_id,
  });
  if (aerr || !areaJson) throw new Error(aerr?.message ?? 'could not load area');

  // Compute first next_run_at off the cadence + hour, anchored to now.
  const { data: nextAt } = await supa.rpc('forecast_template_next_at', {
    p_after: new Date().toISOString(),
    p_cadence: parsed.cadence,
    p_hour: parsed.hour_of_day,
  });

  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) throw new Error('not authenticated');

  // Insert via raw SQL through RPC would be cleaner but we have no helper;
  // PostGIS conversion happens via st_geomfromgeojson inside the update
  // trigger… actually the table column is geography, so we cast inline.
  // Use a small RPC to do the conversion server-side.
  const { data: id, error } = await supa.rpc('forecast_template_create', {
    p_name: parsed.name,
    p_area: areaJson,
    p_hazards: src.hazards ?? [],
    p_confidence: src.confidence,
    p_cadence: parsed.cadence,
    p_hour_of_day: parsed.hour_of_day,
    p_window_hours: parsed.window_hours,
    p_next_run_at: nextAt,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/forecast/templates');
  return { id: id as string };
}

export async function setForecastTemplateEnabled(id: string, enabled: boolean): Promise<void> {
  const supa = supabaseServer();
  const { error } = await supa
    .from('forecast_templates')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/forecast/templates');
}

export async function deleteForecastTemplate(id: string): Promise<void> {
  const supa = supabaseServer();
  const { error } = await supa.from('forecast_templates').delete().eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/forecast/templates');
}

export async function fireForecastTemplateNow(id: string): Promise<{ forecast_id: string }> {
  const supa = supabaseServer();
  // forecast_template_fire is security-definer + service_role-only, so route
  // through admin. Operator gate is enforced via the RLS check on the row
  // read below.
  const { data: own } = await supa
    .from('forecast_templates')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (!own) throw new Error('template not found');

  const { supabaseAdmin } = await import('@/lib/supabase/server');
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('forecast_template_fire', { p_template_id: id });
  if (error) throw new Error(error.message);
  revalidatePath('/forecast/templates');
  revalidatePath('/forecast');
  return { forecast_id: data as string };
}
