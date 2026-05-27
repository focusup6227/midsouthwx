import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtTs, relTime } from '@/lib/nws/display';
import AlertMap from '@/app/alert/[nws_id]/AlertMap';

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
    .select('id, body_md, body_rendered, audience_spec, media_url, media_type, source, created_at, sent_at')
    .eq('id', params.id)
    .maybeSingle();

  if (!msg) notFound();

  const geom = normalize((msg.audience_spec as { geometry?: unknown } | null)?.geometry);
  const sentAt = msg.sent_at ?? msg.created_at;
  const body = msg.body_rendered ?? msg.body_md;

  return (
    <main className="min-h-dvh bg-wx-bg text-wx-fg">
      <div className="mx-auto max-w-2xl px-4 py-6 space-y-5">
        <header className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-wx-mute">
            MidSouthWX alert · sent {relTime(sentAt)}
          </p>
          <p className="text-[11px] text-wx-mute">{fmtTs(sentAt)}</p>
        </header>

        {geom ? <AlertMap geometry={geom} fill="#ef4444" /> : null}

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

        <footer className="pt-2 text-xs text-wx-mute">
          MidSouthWX · Severe weather alerts
        </footer>
      </div>
    </main>
  );
}
