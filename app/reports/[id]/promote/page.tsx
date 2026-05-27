import { notFound } from 'next/navigation';
import Link from 'next/link';
import DashShell from '@/components/DashShell';
import { supabaseServer } from '@/lib/supabase/server';
import { promoteReportFromForm } from '../../actions';
import { defaultPromotionBody } from '../../promotion-template';
import PromoteForm from './PromoteForm';

export const dynamic = 'force-dynamic';

const HAZARD_LABEL: Record<string, string> = {
  tornado: 'Tornado',
  funnel: 'Funnel cloud',
  wind: 'Damaging wind',
  hail: 'Hail',
  flood: 'Flooding',
  other: 'Severe weather',
};

export default async function PromotePage({ params }: { params: { id: string } }) {
  const supa = supabaseServer();
  const { data: report } = await supa
    .from('telegram_storm_reports')
    .select('id, hazard, description, photo_url, lat, lon, place_name, status, reported_at, subscriber:subscribers(display_name, telegram_username)')
    .eq('id', params.id)
    .maybeSingle();

  if (!report) notFound();
  const sub = Array.isArray(report.subscriber) ? report.subscriber[0] : report.subscriber;
  const reporter = sub?.telegram_username
    ? `@${sub.telegram_username}`
    : sub?.display_name ?? 'subscriber';

  const defaultBody = defaultPromotionBody({
    hazard: report.hazard,
    place_name: report.place_name,
    lat: report.lat,
    lon: report.lon,
    description: report.description,
  });

  return (
    <DashShell
      title="Promote to broadcast"
      backHref="/reports"
      width="normal"
    >
      <p className="text-wx-mute text-sm">
        Sends a Telegram message to every active subscriber whose pin sits inside the
        radius below — uses the same audience resolver as <code className="text-xs">/compose</code>.
        Marks the report as <span className="text-sky-300">promoted</span> and links the
        outbound message back to it.
      </p>

      <div className="card p-4 my-4 space-y-3">
        <div className="flex items-start gap-4">
          {report.photo_url ? (
            <a
              href={report.photo_url}
              target="_blank"
              rel="noreferrer"
              className="block w-32 shrink-0 rounded-md overflow-hidden border border-wx-line"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={report.photo_url}
                alt="Storm report"
                className="w-full h-32 object-cover bg-wx-ink"
              />
            </a>
          ) : null}
          <div className="min-w-0 space-y-1">
            <div className="text-[13px] font-semibold">
              {HAZARD_LABEL[report.hazard] ?? report.hazard}
            </div>
            <div className="text-[11px] text-wx-mute">
              {report.place_name ?? `${report.lat.toFixed(3)}, ${report.lon.toFixed(3)}`}
            </div>
            <div className="text-[11px] text-wx-mute">
              {reporter} · {new Date(report.reported_at).toLocaleString()}
            </div>
            {report.description ? (
              <p className="text-[11.5px] text-wx-fg/85 italic mt-1">
                &quot;{report.description}&quot;
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {report.status === 'promoted' ? (
        <p className="text-sm text-wx-mute">
          This report is already promoted.{' '}
          <Link href="/reports" className="text-wx-accent">Back to triage</Link>
        </p>
      ) : (
        <PromoteForm
          id={report.id}
          defaultBody={defaultBody}
          action={promoteReportFromForm}
        />
      )}
    </DashShell>
  );
}
