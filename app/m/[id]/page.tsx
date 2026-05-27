import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtTs, relTime, nwsApiUrl } from '@/lib/nws/display';
import AlertMap from '@/app/alert/[nws_id]/AlertMap';

// Same severity palette as /alert/[nws_id] so adopted-alert pages match the
// dispatcher-routed alert page when both are linked to the same NWS event.
const SEVERITY_FILL: Record<string, string> = {
  Extreme: '#ef4444',
  Severe: '#f97316',
  Moderate: '#eab308',
  Minor: '#3b82f6',
  Unknown: '#94a3b8',
};

type NwsRawGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

function extractNwsGeometry(raw: unknown): NwsRawGeometry | null {
  const g = (raw as { geometry?: unknown } | null)?.geometry as
    | { type?: string }
    | undefined;
  if (!g) return null;
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') return g as NwsRawGeometry;
  return null;
}

export const dynamic = 'force-dynamic';

type Polygon = { type: 'Polygon'; coordinates: number[][][] };
type MultiPolygon = { type: 'MultiPolygon'; coordinates: number[][][][] };
type CircleSpec = { type: 'circle'; center: [number, number]; radius_km: number };
type TrackSpec = { type: 'track'; line: number[][]; corridor_km?: number };
type FlatPolygon = { type: 'polygon'; coordinates: number[][] | number[][][] };

const CIRCLE_SEGMENTS = 48;

function circleToPolygon(center: [number, number], radiusKm: number): Polygon {
  const [lon, lat] = center;
  const kmPerDegLat = 111.32;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const kmPerDegLon = cosLat > 1e-9 ? 111.32 * cosLat : 111.32;
  const ring: number[][] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const theta = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
    ring.push([
      lon + (radiusKm * Math.sin(theta)) / kmPerDegLon,
      lat + (radiusKm * Math.cos(theta)) / kmPerDegLat,
    ]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

// Buffer a LineString by `corridor_km` into a Polygon by extruding perpendicular
// offsets at each vertex. Good enough for visualization of a "send to path"
// corridor; not a precise geodesic buffer.
function trackToPolygon(line: number[][], corridorKm = 8): Polygon | null {
  if (!Array.isArray(line) || line.length < 2) return null;
  const kmPerDegLat = 111.32;
  const lat0 = line[0][1];
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const kmPerDegLon = cosLat > 1e-9 ? 111.32 * cosLat : 111.32;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular unit vector in degrees, scaled by corridor_km/2.
    const half = corridorKm / 2;
    const nx = (-dy / len) * (half / kmPerDegLon);
    const ny = (dx / len) * (half / kmPerDegLat);
    left.push([line[i][0] + nx, line[i][1] + ny]);
    right.push([line[i][0] - nx, line[i][1] - ny]);
  }
  const ring = [...left, ...right.reverse(), left[0]];
  return { type: 'Polygon', coordinates: [ring] };
}

function normalize(geom: unknown): Polygon | MultiPolygon | null {
  if (!geom || typeof geom !== 'object') return null;
  const g = geom as { type?: string; coordinates?: unknown };
  if (typeof g.type !== 'string') return null;
  const t = g.type.toLowerCase();
  if (t === 'polygon') {
    const coords = (g as FlatPolygon).coordinates;
    if (!Array.isArray(coords) || coords.length === 0) return null;
    const first = coords[0] as unknown[];
    if (Array.isArray(first) && Array.isArray(first[0])) {
      return { type: 'Polygon', coordinates: coords as number[][][] };
    }
    if (Array.isArray(first) && typeof first[0] === 'number') {
      return { type: 'Polygon', coordinates: [coords as number[][]] };
    }
    return null;
  }
  if (t === 'multipolygon') return geom as MultiPolygon;
  if (t === 'circle') {
    const c = geom as CircleSpec;
    if (!Array.isArray(c.center) || typeof c.radius_km !== 'number') return null;
    return circleToPolygon([c.center[0], c.center[1]], c.radius_km);
  }
  if (t === 'track') {
    const tr = geom as TrackSpec;
    return trackToPolygon(tr.line, tr.corridor_km ?? 8);
  }
  return null;
}

export default async function PublicMessagePage({
  params,
}: {
  params: { id: string };
}) {
  const supa = supabaseServer();
  const { data: msg } = await supa
    .from('messages')
    .select(
      'id, body_md, body_rendered, audience_spec, media_url, media_type, source, created_at, sent_at, nws_alert_id',
    )
    .eq('id', params.id)
    .maybeSingle();

  if (!msg) notFound();

  // When the operator adopted an NWS warning from /radar, the source alert
  // is linked via nws_alert_id and we render its full CAP context here so
  // the public page reads like /alert/[nws_id] does for dispatcher-routed
  // messages — same severity coloring, headline, area, timing, instruction,
  // and a polygon fallback for the map when the audience isn't geometry.
  const nwsAlertRes = msg.nws_alert_id
    ? await supa
        .from('nws_alerts')
        .select(
          'nws_id, event, severity, urgency, certainty, headline, description, instruction, area_desc, effective, expires_at, raw',
        )
        .eq('id', msg.nws_alert_id)
        .maybeSingle()
    : null;
  const nwsAlert = nwsAlertRes?.data ?? null;

  const audienceGeom = normalize((msg.audience_spec as { geometry?: unknown } | null)?.geometry);
  const nwsGeom = nwsAlert ? extractNwsGeometry(nwsAlert.raw) : null;
  const mapGeom = audienceGeom ?? nwsGeom;
  const fill = nwsAlert
    ? SEVERITY_FILL[nwsAlert.severity ?? 'Unknown'] ?? SEVERITY_FILL.Unknown
    : '#ef4444';

  const sentAt = msg.sent_at ?? msg.created_at;
  const body = msg.body_rendered ?? msg.body_md;
  const isActive =
    !nwsAlert?.expires_at || new Date(nwsAlert.expires_at).getTime() > Date.now();

  return (
    <main className="min-h-dvh bg-wx-bg text-wx-fg">
      <div className="mx-auto max-w-2xl px-4 py-6 space-y-5">
        <header className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-wx-mute">
            MidSouthWX alert · sent {relTime(sentAt)}
          </p>
          <p className="text-[11px] text-wx-mute">{fmtTs(sentAt)}</p>
        </header>

        {mapGeom ? <AlertMap geometry={mapGeom} fill={fill} /> : null}

        <section className="card p-4">
          <pre className="whitespace-pre-wrap font-sans text-sm text-wx-fg/95">
            {body}
          </pre>
        </section>

        {msg.media_url && msg.media_type === 'photo' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={msg.media_url}
            alt="Alert area map"
            className="w-full rounded-lg border border-wx-line"
          />
        ) : null}

        {nwsAlert ? (
          <>
            <header className="space-y-2 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="inline-block w-3 h-3 rounded-full"
                  style={{ backgroundColor: fill }}
                  aria-hidden
                />
                <h1 className="text-xl font-bold leading-tight">{nwsAlert.event}</h1>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-wide">
                {nwsAlert.severity ? (
                  <span
                    className="px-1.5 py-0.5 rounded text-black"
                    style={{ backgroundColor: fill }}
                  >
                    {nwsAlert.severity}
                  </span>
                ) : null}
                {nwsAlert.urgency ? (
                  <span className="px-1.5 py-0.5 rounded bg-wx-line text-wx-mute">
                    {nwsAlert.urgency} urgency
                  </span>
                ) : null}
                {nwsAlert.certainty ? (
                  <span className="px-1.5 py-0.5 rounded bg-wx-line text-wx-mute">
                    {nwsAlert.certainty} certainty
                  </span>
                ) : null}
                {!isActive ? (
                  <span className="px-1.5 py-0.5 rounded bg-wx-line text-wx-mute">
                    expired
                  </span>
                ) : null}
              </div>
            </header>

            {nwsAlert.headline ? (
              <p
                className="text-sm text-wx-fg/90 border-l-2 pl-3"
                style={{ borderColor: fill }}
              >
                {nwsAlert.headline}
              </p>
            ) : null}

            {nwsAlert.area_desc ? (
              <section className="card p-4 space-y-1">
                <h2 className="text-xs uppercase tracking-wide text-wx-mute">Area</h2>
                <p className="text-sm">{nwsAlert.area_desc}</p>
              </section>
            ) : null}

            <section className="card p-4 space-y-2">
              <h2 className="text-xs uppercase tracking-wide text-wx-mute">Timing</h2>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-wx-mute text-xs">Effective</dt>
                  <dd>{fmtTs(nwsAlert.effective)}</dd>
                </div>
                <div>
                  <dt className="text-wx-mute text-xs">Expires</dt>
                  <dd>
                    {fmtTs(nwsAlert.expires_at)}
                    {nwsAlert.expires_at
                      ? ` · ${relTime(nwsAlert.expires_at, { future: true })}`
                      : ''}
                  </dd>
                </div>
              </dl>
            </section>

            {nwsAlert.instruction ? (
              <section className="card p-4 space-y-2">
                <h2 className="text-xs uppercase tracking-wide text-wx-mute">
                  What to do
                </h2>
                <pre className="whitespace-pre-wrap font-sans text-sm text-wx-fg/95">
                  {nwsAlert.instruction}
                </pre>
              </section>
            ) : null}

            {nwsAlert.description ? (
              <section className="card p-4 space-y-2">
                <h2 className="text-xs uppercase tracking-wide text-wx-mute">
                  Details
                </h2>
                <pre className="whitespace-pre-wrap font-sans text-sm text-wx-fg/90">
                  {nwsAlert.description}
                </pre>
              </section>
            ) : null}

            <p className="text-xs text-wx-mute">
              Source:{' '}
              <a
                href={nwsApiUrl(nwsAlert.nws_id)}
                target="_blank"
                rel="noreferrer"
                className="text-wx-accent"
              >
                National Weather Service
              </a>
            </p>
          </>
        ) : null}

        <footer className="pt-2 text-xs text-wx-mute">
          MidSouthWX · Severe weather alerts
        </footer>
      </div>
    </main>
  );
}
