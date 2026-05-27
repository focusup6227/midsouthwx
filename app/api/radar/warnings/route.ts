import { supabaseServer } from '@/lib/supabase/server';
import {
  classifyNwsEvent,
  geometryCentroid,
  nwsRadarLabel,
  type NwsRadarAlert,
} from '@/lib/nws/radar';
import { buildStormTracksCollection } from '@/lib/nws/storm-tracks';
import { classifyAlertSeverity } from '@/lib/nws/display';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Per-hazard corridor half-width (km) when projecting a storm-track impact
// audience. Tighter corridors reduce noise (fewer subscribers alerted who
// aren't really in the path) but increase the chance of a near-miss
// subscriber being missed entirely. Widths chosen to balance:
//
//   tornado emergency / PDS: 3 km — strongest tornadoes have narrow damage
//     swaths but still warrant a tight, high-confidence corridor since the
//     subscribers caught up in it will be in extreme danger.
//   tornado (routine): 5 km — typical EF0-EF2 swath plus margin.
//   severe (thunderstorm/hail/wind): 7 km — convective cells have wider
//     impact areas (downbursts, hail swaths) than tornadoes.
//   flood: 10 km — flash flood threats follow drainage networks far from
//     the forecast track centroid, so a wider corridor catches downstream.
//   default: 8 km — back-compat with the prior behavior for unknown hazards.
//
// Centralized here so all callers (radar inspector, audience-along-track)
// stay consistent.
const CORRIDOR_KM_BY_HAZARD: Record<string, number> = {
  tornado_emergency: 3,
  pds_tornado: 3,
  tornado: 5,
  severe: 7,
  flood: 10,
};
const DEFAULT_CORRIDOR_KM = 8;

function corridorKmFor(hazard: string | null | undefined, severe: { isPds: boolean; isTornadoEmergency: boolean }): number {
  if (severe.isTornadoEmergency) return CORRIDOR_KM_BY_HAZARD.tornado_emergency;
  if (severe.isPds && hazard === 'tornado') return CORRIDOR_KM_BY_HAZARD.pds_tornado;
  return CORRIDOR_KM_BY_HAZARD[hazard ?? ''] ?? DEFAULT_CORRIDOR_KM;
}

type Geom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

function parseFeatureCollection(raw: unknown): GeoJSON.FeatureCollection<Geom> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { type?: string; features?: unknown[] };
  if (o.type !== 'FeatureCollection' || !Array.isArray(o.features)) return null;
  return o as GeoJSON.FeatureCollection<Geom>;
}

export async function GET() {
  const supa = supabaseServer();

  const { data: fcRaw, error } = await supa.rpc('nws_alerts_radar_geojson');

  const emptyTracks = { type: 'FeatureCollection' as const, features: [] };

  if (error) {
    return NextResponse.json(
      {
        warnings: [] as NwsRadarAlert[],
        geojson: { type: 'FeatureCollection', features: [] },
        tracks: emptyTracks,
        error: error.message,
      },
      { status: 200 },
    );
  }

  const fc =
    parseFeatureCollection(fcRaw) ?? { type: 'FeatureCollection' as const, features: [] };
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
      // Filled in below once we have the tracks collection.
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

  const warningIds = warnings.map((w) => w.id).filter(Boolean);
  const { data: trackRows } = warningIds.length
    ? await supa
        .from('nws_alerts')
        .select('id, event, raw')
        .in('id', warningIds)
    : { data: [] };

  const tracks = buildStormTracksCollection(
    (trackRows ?? []).map((r) => ({
      id: r.id,
      event: r.event,
      raw: r.raw,
    })),
  );

  // Index PDS/TorE flags by alert id so the per-hazard corridor picker can
  // tighten the buffer for the most-severe warnings.
  const severeFlagsByAlertId = new Map<string, ReturnType<typeof classifyAlertSeverity>>();
  for (const r of trackRows ?? []) {
    severeFlagsByAlertId.set(r.id, classifyAlertSeverity(r.raw, r.event));
  }

  // F3: for each warning that has a forecast track, count subscribers inside
  // the corridor and attach the line + count to the warning row. Done
  // server-side so the client gets a single roundtrip instead of N RPC calls
  // from the radar page.
  const forecastByAlertId = new Map<string, GeoJSON.LineString>();
  for (const tf of tracks.features) {
    const props = tf.properties as { alert_id?: string; segment?: string } | null;
    if (
      props?.segment === 'forecast' &&
      props.alert_id &&
      tf.geometry?.type === 'LineString'
    ) {
      forecastByAlertId.set(props.alert_id, tf.geometry);
    }
  }

  await Promise.all(
    warnings.map(async (w) => {
      const line = forecastByAlertId.get(w.id);
      if (!line) return;
      const severeFlags = severeFlagsByAlertId.get(w.id) ?? { isPds: false, isTornadoEmergency: false, any: false };
      const corridorKm = corridorKmFor(w.hazard, severeFlags);
      const { data: rows, error: rpcErr } = await supa.rpc(
        'resolve_audience_along_track',
        { p_line: line, p_corridor_km: corridorKm },
      );
      if (rpcErr) {
        // Log + leave the warning's path fields null. The UI falls back to
        // showing the polygon-only Send button.
        console.warn('resolve_audience_along_track failed', w.id, rpcErr.message);
        return;
      }
      w.forecast_track = line;
      w.in_path_count = Array.isArray(rows) ? rows.length : 0;
      w.in_path_corridor_km = corridorKm;
    }),
  );

  return NextResponse.json(
    { warnings, geojson, tracks },
    { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } },
  );
}
