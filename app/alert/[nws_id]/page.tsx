import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtTs, relTime, nwsApiUrl } from '@/lib/nws/display';
import AlertMap from './AlertMap';

export const dynamic = 'force-dynamic';

const SEVERITY_FILL: Record<string, string> = {
  Extreme: '#ef4444',
  Severe: '#f97316',
  Moderate: '#eab308',
  Minor: '#3b82f6',
  Unknown: '#94a3b8',
};

type Geometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

function extractGeometry(raw: unknown): Geometry | null {
  const g = (raw as { geometry?: unknown } | null)?.geometry as
    | { type?: string }
    | undefined;
  if (!g) return null;
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') return g as Geometry;
  return null;
}

export default async function PublicAlertPage({
  params,
}: {
  params: { nws_id: string };
}) {
  const supa = supabaseServer();
  const { data: alert } = await supa
    .from('nws_alerts')
    .select(
      'nws_id, event, severity, urgency, certainty, headline, description, instruction, area_desc, sent_at, effective, expires_at, status, raw',
    )
    .eq('nws_id', params.nws_id)
    .maybeSingle();

  if (!alert) notFound();

  const geom = extractGeometry(alert.raw);
  const fill = SEVERITY_FILL[alert.severity ?? 'Unknown'] ?? SEVERITY_FILL.Unknown;
  const isActive =
    !alert.expires_at || new Date(alert.expires_at).getTime() > Date.now();

  return (
    <main className="min-h-dvh bg-wx-bg text-wx-fg">
      <div className="mx-auto max-w-2xl px-4 py-6 space-y-5">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-block w-3 h-3 rounded-full"
              style={{ backgroundColor: fill }}
              aria-hidden
            />
            <h1 className="text-2xl font-bold leading-tight">{alert.event}</h1>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-wide">
            {alert.severity ? (
              <span
                className="px-1.5 py-0.5 rounded text-black"
                style={{ backgroundColor: fill }}
              >
                {alert.severity}
              </span>
            ) : null}
            {alert.urgency ? (
              <span className="px-1.5 py-0.5 rounded bg-wx-line text-wx-mute">
                {alert.urgency} urgency
              </span>
            ) : null}
            {alert.certainty ? (
              <span className="px-1.5 py-0.5 rounded bg-wx-line text-wx-mute">
                {alert.certainty} certainty
              </span>
            ) : null}
            {!isActive ? (
              <span className="px-1.5 py-0.5 rounded bg-wx-line text-wx-mute">
                expired
              </span>
            ) : null}
          </div>
        </header>

        {alert.headline ? (
          <p className="text-sm text-wx-fg/90 border-l-2 pl-3" style={{ borderColor: fill }}>
            {alert.headline}
          </p>
        ) : null}

        {geom ? <AlertMap geometry={geom} fill={fill} /> : null}

        {alert.area_desc ? (
          <section className="card p-4 space-y-1">
            <h2 className="text-xs uppercase tracking-wide text-wx-mute">Area</h2>
            <p className="text-sm">{alert.area_desc}</p>
          </section>
        ) : null}

        <section className="card p-4 space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-wx-mute">Timing</h2>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-wx-mute text-xs">Effective</dt>
              <dd>{fmtTs(alert.effective)}</dd>
            </div>
            <div>
              <dt className="text-wx-mute text-xs">Expires</dt>
              <dd>
                {fmtTs(alert.expires_at)}
                {alert.expires_at ? ` · ${relTime(alert.expires_at, { future: true })}` : ''}
              </dd>
            </div>
          </dl>
        </section>

        {alert.instruction ? (
          <section className="card p-4 space-y-2">
            <h2 className="text-xs uppercase tracking-wide text-wx-mute">
              What to do
            </h2>
            <pre className="whitespace-pre-wrap font-sans text-sm text-wx-fg/95">
              {alert.instruction}
            </pre>
          </section>
        ) : null}

        {alert.description ? (
          <section className="card p-4 space-y-2">
            <h2 className="text-xs uppercase tracking-wide text-wx-mute">
              Details
            </h2>
            <pre className="whitespace-pre-wrap font-sans text-sm text-wx-fg/90">
              {alert.description}
            </pre>
          </section>
        ) : null}

        <footer className="pt-2 text-xs text-wx-mute space-y-1">
          <p>
            Source:{' '}
            <a
              href={nwsApiUrl(alert.nws_id)}
              target="_blank"
              rel="noreferrer"
              className="text-wx-accent"
            >
              National Weather Service
            </a>
          </p>
          <p>MidSouthWX · Severe weather alerts</p>
        </footer>
      </div>
    </main>
  );
}
