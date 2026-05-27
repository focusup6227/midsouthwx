import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Send } from 'lucide-react';
import { supabaseServer } from '@/lib/supabase/server';
import DashShell from '@/components/DashShell';
import {
  STATUS_TONE,
  SEVERITY_TONE,
  fmtTs,
  nwsApiUrl,
  relTime,
} from '@/lib/nws/display';
import { classifyNwsEvent } from '@/lib/nws/radar';

export const dynamic = 'force-dynamic';

const MSG_STATUS_COLOR: Record<string, string> = {
  draft: 'text-wx-mute',
  queued: 'text-wx-accent',
  sending: 'text-wx-accent',
  sent: 'text-wx-ok',
  failed: 'text-wx-danger',
  cancelled: 'text-wx-mute',
  pending_approval: 'text-wx-accent',
};

export default async function NwsAlertDetailPage({ params }: { params: { id: string } }) {
  const supa = supabaseServer();

  const { data: alert } = await supa
    .from('nws_alerts')
    .select(
      'id, nws_id, event, severity, certainty, urgency, headline, description, instruction, area_desc, ugc_codes, same_codes, sent_at, effective, expires_at, status, ingested_at, references_ids, ai_summary, raw',
    )
    .eq('id', params.id)
    .maybeSingle();

  if (!alert) notFound();

  // F1+F2: build /compose link if the alert has a polygon. classifyNwsEvent
  // produces the hazard kind that /compose will use to auto-select a template.
  // ai_summary (when present) becomes the default body until the operator
  // picks a template.
  const rawGeometry = (alert.raw as { geometry?: unknown } | null)?.geometry as
    | { type?: string }
    | undefined;
  const hasPolygonGeometry =
    !!rawGeometry &&
    (rawGeometry.type === 'Polygon' || rawGeometry.type === 'MultiPolygon');
  const { hazard } = classifyNwsEvent(alert.event ?? '');
  let composeHref: string | null = null;
  if (hasPolygonGeometry) {
    const params2 = new URLSearchParams();
    params2.set('geo', JSON.stringify(rawGeometry));
    if (hazard && hazard !== 'other') params2.set('hazard', hazard);
    const seed = (alert.ai_summary ?? alert.headline ?? '').trim();
    if (seed) params2.set('body', seed.slice(0, 1000));
    composeHref = `/compose?${params2.toString()}`;
  }

  const { data: messages } = await supa
    .from('messages')
    .select('id, status, recipient_count, created_at, sent_at')
    .eq('nws_alert_id', alert.id)
    .order('created_at', { ascending: false });

  const sevTone = SEVERITY_TONE[alert.severity ?? 'Unknown'] ?? SEVERITY_TONE.Unknown;
  const statusTone = STATUS_TONE[alert.status] ?? '';

  return (
    <DashShell title={alert.event} backHref="/nws" width="narrow">
      <div className="flex flex-wrap gap-2">
        <span
          className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${sevTone}`}
        >
          {alert.severity ?? 'Unknown severity'}
        </span>
        <span
          className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${statusTone}`}
        >
          {alert.status}
        </span>
        {alert.urgency ? (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-wx-line text-wx-mute">
            {alert.urgency} urgency
          </span>
        ) : null}
        {alert.certainty ? (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-wx-line text-wx-mute">
            {alert.certainty} certainty
          </span>
        ) : null}
      </div>

      {composeHref ? (
        <a
          href={composeHref}
          className="inline-flex items-center gap-2 self-start px-3 py-2 bg-wx-accent text-black rounded-lg text-sm font-semibold hover:bg-amber-300"
        >
          <Send size={14} /> Send to subscribers in this polygon
        </a>
      ) : null}

      {alert.ai_summary ? (
        <p className="text-sm text-wx-fg/95 border-l-2 border-wx-accent pl-3">
          {alert.ai_summary}
        </p>
      ) : null}

      {alert.headline ? (
        <p className="text-sm text-wx-fg/90">{alert.headline}</p>
      ) : null}

      {alert.area_desc ? (
        <p className="text-sm text-wx-mute">{alert.area_desc}</p>
      ) : null}

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Timing</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-wx-mute text-xs">Ingested</dt>
            <dd>
              {fmtTs(alert.ingested_at)} ({relTime(alert.ingested_at)})
            </dd>
          </div>
          <div>
            <dt className="text-wx-mute text-xs">Sent (NWS)</dt>
            <dd>{fmtTs(alert.sent_at)}</dd>
          </div>
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

      {alert.description ? (
        <section className="card p-5 space-y-2">
          <h2 className="font-semibold">Description</h2>
          <pre className="whitespace-pre-wrap font-sans text-sm text-wx-fg/90">
            {alert.description}
          </pre>
        </section>
      ) : null}

      {alert.instruction ? (
        <section className="card p-5 space-y-2">
          <h2 className="font-semibold">Instructions</h2>
          <pre className="whitespace-pre-wrap font-sans text-sm text-wx-fg/90">
            {alert.instruction}
          </pre>
        </section>
      ) : null}

      {(alert.ugc_codes?.length || alert.same_codes?.length || alert.references_ids?.length) ? (
        <section className="card p-5 space-y-3">
          <h2 className="font-semibold">Codes & references</h2>
          {alert.same_codes?.length ? (
            <div>
              <div className="text-xs text-wx-mute mb-1">SAME (county FIPS)</div>
              <p className="text-xs font-mono break-all">{alert.same_codes.join(', ')}</p>
            </div>
          ) : null}
          {alert.ugc_codes?.length ? (
            <div>
              <div className="text-xs text-wx-mute mb-1">Affected zones (UGC)</div>
              <ul className="text-xs font-mono space-y-1 break-all">
                {alert.ugc_codes.map((z: string) => (
                  <li key={z}>{z}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {alert.references_ids?.length ? (
            <div>
              <div className="text-xs text-wx-mute mb-1">Supersedes / references</div>
              <ul className="text-xs space-y-1 break-all">
                {alert.references_ids.map((r: string) => (
                  <li key={r}>
                    <a href={nwsApiUrl(r)} target="_blank" rel="noreferrer" className="text-wx-accent">
                      {r}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Outbound messages</h2>
        {!messages?.length ? (
          <p className="text-sm text-wx-mute">No message was created from this alert.</p>
        ) : (
          <ul className="divide-y divide-wx-line text-sm">
            {messages.map((m) => (
              <li key={m.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <Link href={`/alerts/${m.id}`} className="text-wx-accent font-medium">
                  Open message →
                </Link>
                <span className={MSG_STATUS_COLOR[m.status] ?? 'text-wx-mute'}>{m.status}</span>
                <span className="text-xs text-wx-mute w-full">
                  {m.recipient_count ?? 0} recipients · {fmtTs(m.created_at)}
                  {m.sent_at ? ` · sent ${fmtTs(m.sent_at)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-sm">
        <a
          href={nwsApiUrl(alert.nws_id)}
          target="_blank"
          rel="noreferrer"
          className="text-wx-accent"
        >
          View on api.weather.gov →
        </a>
      </p>
    </DashShell>
  );
}
