import DashShell from '@/components/DashShell';
import { supabaseServer } from '@/lib/supabase/server';
import { classifyNwsEvent, geometryCentroid, nwsRadarLabel, type NwsRadarAlert } from '@/lib/nws/radar';
import { buildStormTracksCollection } from '@/lib/nws/storm-tracks';
import RadarRoute from './_components/RadarRoute';

export const dynamic = 'force-dynamic';

type SpcDay = {
  day_number: number;
  geojson: GeoJSON.FeatureCollection;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  highest_label: string | null;
};

type Geom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

type WarningsResponse = {
  warnings: NwsRadarAlert[];
  geojson: GeoJSON.FeatureCollection;
  tracks: GeoJSON.FeatureCollection;
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const EMPTY_WARNINGS: WarningsResponse = { warnings: [], geojson: EMPTY_FC, tracks: EMPTY_FC };

function parseFeatureCollection(raw: unknown): GeoJSON.FeatureCollection<Geom> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { type?: string; features?: unknown[] };
  if (o.type !== 'FeatureCollection' || !Array.isArray(o.features)) return null;
  return o as GeoJSON.FeatureCollection<Geom>;
}

// Server-side warnings build that matches `/api/radar/warnings`'s response
// shape but *skips* the per-warning resolve_audience_along_track loop. That
// loop can take several seconds with active convective weather, so we let
// the client SWR refetch fill in `forecast_track` / `in_path_count` ~1 s
// after hydration. The polygon overlay paints from the SSR HTML.
async function fetchInitialWarnings(): Promise<WarningsResponse> {
  const supa = supabaseServer();
  try {
    const [fcRes, trackRes] = await Promise.all([
      supa.rpc('nws_alerts_radar_geojson'),
      supa
        .from('nws_alerts')
        .select('id, event, raw')
        .in('status', ['new', 'dispatched'])
        .or('event.ilike.%Warning%,event.ilike.%Emergency%,event.ilike.%Special Marine%')
        .limit(500),
    ]);

    if (fcRes.error || !fcRes.data) return EMPTY_WARNINGS;
    const fc = parseFeatureCollection(fcRes.data) ?? { type: 'FeatureCollection' as const, features: [] };

    const warnings: NwsRadarAlert[] = [];
    for (const f of fc.features) {
      const geom = f.geometry;
      if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const event = String(p.event ?? 'Alert');
      const { category, hazard } = classifyNwsEvent(event);
      warnings.push({
        id: String(p.id ?? f.id ?? ''),
        nws_id: String(p.nws_id ?? ''),
        category,
        hazard,
        event,
        label: nwsRadarLabel(event, (p.area_desc as string | null) ?? null),
        headline: (p.headline as string | null) ?? null,
        ai_summary: (p.ai_summary as string | null) ?? null,
        area_desc: (p.area_desc as string | null) ?? null,
        severity: (p.severity as string | null) ?? null,
        expires_at: (p.expires_at as string | null) ?? null,
        effective: (p.effective as string | null) ?? null,
        centroid: geometryCentroid(geom),
        geometry: geom,
        forecast_track: null,
        in_path_count: null,
        in_path_corridor_km: null,
      });
    }

    const geojson: GeoJSON.FeatureCollection<Geom> = {
      type: 'FeatureCollection',
      features: warnings.map((w) => ({
        type: 'Feature',
        id: w.id,
        geometry: w.geometry,
        properties: {
          id: w.id,
          nws_id: w.nws_id,
          category: w.category,
          hazard: w.hazard,
          event: w.event,
          label: w.label,
          headline: w.headline,
          ai_summary: w.ai_summary,
          area_desc: w.area_desc,
          severity: w.severity,
          expires_at: w.expires_at,
          effective: w.effective,
        },
      })),
    };

    const tracks = buildStormTracksCollection(
      (trackRes.data ?? []).map((r) => ({ id: r.id, event: r.event, raw: r.raw })),
    );

    return { warnings, geojson, tracks };
  } catch {
    return EMPTY_WARNINGS;
  }
}

async function fetchInitialRadarData(): Promise<{
  subs: GeoJSON.FeatureCollection;
  spc: SpcDay[];
  warnings: WarningsResponse;
}> {
  const supa = supabaseServer();
  const [subsRes, spcRes, warnings] = await Promise.all([
    supa.rpc('subscriber_locations_geojson').then(
      (r) => ({ data: r.data, error: r.error }),
      () => ({ data: null, error: { message: 'rpc_threw' } }),
    ),
    supa
      .from('spc_outlooks')
      .select('day_number, geojson, issued_at, valid_from, valid_until, highest_label')
      .in('day_number', [1, 2, 3])
      .order('day_number')
      .then(
        (r) => ({ data: r.data, error: r.error }),
        () => ({ data: null, error: { message: 'query_threw' } }),
      ),
    fetchInitialWarnings(),
  ]);

  const subs = (subsRes.error || !subsRes.data) ? EMPTY_FC : (subsRes.data as GeoJSON.FeatureCollection);
  const spc = (spcRes.error || !spcRes.data) ? [] : (spcRes.data as SpcDay[]);
  return { subs, spc, warnings };
}

function preflightEnvWarnings(): string[] {
  const warnings: string[] = [];
  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
    warnings.push('NEXT_PUBLIC_MAPBOX_TOKEN missing — basemap and all overlays will fail to render.');
  }
  if (!process.env.RENDERER_BASE_URL || !process.env.RENDERER_TOKEN) {
    warnings.push('RENDERER_BASE_URL or RENDERER_TOKEN missing — Hi-Res (Level II) reflectivity, velocity, and correlation coefficient will be unavailable.');
  }
  if (!process.env.NWS_USER_AGENT) {
    warnings.push('NWS_USER_AGENT missing — server-side NWS/SPC/AFD fetches will be rejected by api.weather.gov.');
  }
  return warnings;
}

export default async function RadarPage() {
  const { subs, spc, warnings } = await fetchInitialRadarData();
  const envWarnings = preflightEnvWarnings();
  return (
    <DashShell width="full" bare>
      <RadarRoute
        initialSubsGeo={subs}
        initialSpcDays={spc}
        initialWarnings={warnings}
        envWarnings={envWarnings}
      />
    </DashShell>
  );
}
