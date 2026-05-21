import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import {
  createAutoRule,
  deleteAutoRuleAction,
  updateAutoRule,
} from './actions';
import RuleToggle from './RuleToggle';
import NwsApproveButtons from './NwsApproveButtons';
import NwsRefresher from './NwsRefresher';
import RunButtons from './RunButtons';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

type RegionFilter = { region_ids?: string[] };

type AlertRow = {
  id: string;
  nws_id: string;
  event: string;
  severity: string | null;
  headline: string | null;
  area_desc: string | null;
  status: string;
  expires_at: string | null;
  ingested_at: string;
};

const ALL_STATUSES = [
  'new',
  'dispatched',
  'skipped',
  'superseded',
  'cancelled',
  'expired',
] as const;

const SEVERITY_TONE: Record<string, string> = {
  Extreme: 'bg-wx-danger text-black',
  Severe: 'bg-orange-500/90 text-black',
  Moderate: 'bg-yellow-500/80 text-black',
  Minor: 'bg-blue-500/70 text-white',
  Unknown: 'bg-wx-line text-wx-mute',
};

const STATUS_TONE: Record<string, string> = {
  new: 'bg-wx-accent/20 text-wx-accent',
  dispatched: 'bg-wx-ok/20 text-wx-ok',
  skipped: 'bg-wx-line text-wx-mute',
  superseded: 'bg-wx-line text-wx-mute line-through',
  cancelled: 'bg-wx-line text-wx-mute',
  expired: 'bg-wx-line text-wx-mute',
};

function relTime(iso: string | null, opts: { future?: boolean } = {}): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  let v: string;
  if (m < 1) v = 'just now';
  else if (m < 60) v = `${m}m`;
  else if (h < 24) v = `${h}h`;
  else v = `${d}d`;
  if (opts.future) return ms < 0 ? `expired ${v} ago` : `in ${v}`;
  return ms <= 0 ? `${v} ago` : `in ${v}`;
}

export default async function NwsPage({
  searchParams,
}: {
  searchParams?: { status?: string };
}) {
  const supa = supabaseServer();
  const filterStatus = ALL_STATUSES.includes(searchParams?.status as never)
    ? (searchParams!.status as (typeof ALL_STATUSES)[number])
    : null;

  let alertsQ = supa
    .from('nws_alerts')
    .select(
      'id, nws_id, event, severity, headline, area_desc, status, expires_at, ingested_at',
    )
    .order('ingested_at', { ascending: false })
    .limit(100);
  if (filterStatus) alertsQ = alertsQ.eq('status', filterStatus);

  const [
    { data: alerts },
    { data: pendingMsgs },
    { data: rules },
    { data: templates },
    { data: regions },
    statusCountsResults,
  ] = await Promise.all([
    alertsQ,
    supa
      .from('messages')
      .select(
        'id, body_md, recipient_count, created_at, nws_alert_id, quick_replies',
      )
      .eq('source', 'nws')
      .eq('status', 'pending_approval')
      .order('created_at', { ascending: false }),
    supa
      .from('auto_alert_rules')
      .select(
        'id, event_pattern, min_severity, mode, region_filter, template_id, enabled, created_at, templates(name)',
      )
      .order('created_at', { ascending: true }),
    supa.from('templates').select('id, name').order('name'),
    supa.from('regions').select('id, name, kind').order('name'),
    Promise.all(
      ALL_STATUSES.map((s) =>
        supa
          .from('nws_alerts')
          .select('id', { count: 'exact', head: true })
          .eq('status', s)
          .then((r) => ({ status: s, count: r.count ?? 0 })),
      ),
    ),
  ]);

  const statusCounts = new Map(statusCountsResults.map((r) => [r.status, r.count]));
  const regionName = new Map((regions ?? []).map((r) => [r.id, r.name]));

  // Headline number: how many alerts could fire for current subscribers
  // (server-rendered: count distinct events with status='new' or recent).
  const totalAlerts = statusCountsResults.reduce((s, r) => s + r.count, 0);

  return (
    <DashShell title="NWS automation">
      <NwsRefresher />

      <p className="text-sm text-wx-mute">
        {totalAlerts} alerts tracked · live national poll every minute · matches against
        subscriber location/county/forecast zone.
      </p>

      <section className="card p-5 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold">Pipeline controls</h2>
            <p className="text-sm text-wx-mute">
              Cron runs both jobs every minute. Use these to test or re-run on demand.
            </p>
          </div>
        </div>
        <RunButtons />
      </section>

      <section className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            Pending approvals
            {pendingMsgs?.length ? (
              <span className="ml-2 rounded-full bg-wx-accent px-2 py-0.5 text-xs font-bold text-black">
                {pendingMsgs.length}
              </span>
            ) : null}
          </h2>
        </div>
        {!pendingMsgs?.length ? (
          <p className="text-sm text-wx-mute">No NWS messages awaiting approval.</p>
        ) : (
          <ul className="divide-y divide-wx-line">
            {pendingMsgs.map((m) => (
              <li key={m.id} className="py-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/alerts/${m.id}`} className="text-wx-accent text-sm font-medium">
                      Open message →
                    </Link>
                    <pre className="whitespace-pre-wrap font-sans text-sm mt-1 text-wx-fg/90 max-h-32 overflow-y-auto">
                      {m.body_md}
                    </pre>
                    <div className="text-xs text-wx-mute mt-1">
                      {m.recipient_count ?? 0} matched subscribers ·{' '}
                      {new Date(m.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <NwsApproveButtons messageId={m.id} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="font-semibold">Recent NWS alerts</h2>
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <Link
              href="/nws"
              className={`px-2 py-1 rounded border ${
                !filterStatus
                  ? 'border-wx-accent text-wx-accent'
                  : 'border-wx-line text-wx-mute hover:text-wx-fg'
              }`}
            >
              all ({totalAlerts})
            </Link>
            {ALL_STATUSES.map((s) => (
              <Link
                key={s}
                href={`/nws?status=${s}`}
                className={`px-2 py-1 rounded border ${
                  filterStatus === s
                    ? 'border-wx-accent text-wx-accent'
                    : 'border-wx-line text-wx-mute hover:text-wx-fg'
                }`}
              >
                {s} ({statusCounts.get(s) ?? 0})
              </Link>
            ))}
          </div>
        </div>
        {!alerts?.length ? (
          <p className="text-sm text-wx-mute">
            No alerts in this view. Poll runs every minute; check back shortly.
          </p>
        ) : (
          <ul className="divide-y divide-wx-line">
            {(alerts as AlertRow[]).map((a) => {
              const sevTone = SEVERITY_TONE[a.severity ?? 'Unknown'] ?? SEVERITY_TONE.Unknown;
              const statusTone = STATUS_TONE[a.status] ?? '';
              return (
                <li key={a.id} className="py-3">
                  <div className="flex items-start gap-3 flex-wrap">
                    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${sevTone}`}>
                      {a.severity ?? '?'}
                    </span>
                    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${statusTone}`}>
                      {a.status}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{a.event}</div>
                      {a.headline ? (
                        <div className="text-sm text-wx-fg/80 line-clamp-2">{a.headline}</div>
                      ) : null}
                      {a.area_desc ? (
                        <div className="text-xs text-wx-mute line-clamp-1 mt-0.5">
                          {a.area_desc}
                        </div>
                      ) : null}
                    </div>
                    <div className="text-right text-xs text-wx-mute shrink-0 space-y-0.5">
                      <div>ingested {relTime(a.ingested_at)}</div>
                      {a.expires_at ? (
                        <div>{relTime(a.expires_at, { future: true })}</div>
                      ) : null}
                      <a
                        href={
                          a.nws_id.startsWith('http')
                            ? a.nws_id
                            : `https://api.weather.gov/alerts/${encodeURIComponent(a.nws_id)}`
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="text-wx-accent"
                      >
                        api ↗
                      </a>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card p-5 space-y-4">
        <h2 className="font-semibold">Auto-alert rules</h2>
        <p className="text-sm text-wx-mute">
          First matching rule wins (stable order by created time). Patterns match{' '}
          <code className="text-wx-fg">properties.event</code> exactly, or use a trailing{' '}
          <code className="text-wx-fg">*</code> for prefix match.
        </p>

        <div className="border border-wx-line rounded-lg p-4 space-y-3 bg-wx-bg/40">
          <h3 className="text-sm font-medium">New rule</h3>
          <form action={createAutoRule} className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-wx-mute">Event pattern</span>
              <input name="event_pattern" className="mt-1 w-full input" placeholder="Tornado Warning" required />
            </label>
            <label className="block text-sm">
              <span className="text-wx-mute">Min severity (optional)</span>
              <select name="min_severity" className="mt-1 w-full input">
                <option value="">Any</option>
                <option value="minor">Minor</option>
                <option value="moderate">Moderate</option>
                <option value="severe">Severe</option>
                <option value="extreme">Extreme</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-wx-mute">Mode</span>
              <select name="mode" className="mt-1 w-full input" required>
                <option value="review">Review (pending approval)</option>
                <option value="auto">Auto-send</option>
                <option value="ignore">Ignore</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-wx-mute">Template</span>
              <select name="template_id" className="mt-1 w-full input">
                <option value="">—</option>
                {(templates ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <span className="text-wx-mute text-sm">Restrict to regions (optional)</span>
              <div className="mt-2 max-h-40 overflow-y-auto border border-wx-line rounded p-2 grid sm:grid-cols-2 gap-2">
                {(regions ?? []).map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="region_ids" value={r.id} />
                    <span className="truncate">{r.name}</span>
                    <span className="text-wx-mute text-xs">({r.kind})</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <button type="submit" className="btn">
                Add rule
              </button>
            </div>
          </form>
        </div>

        {!rules?.length ? (
          <p className="text-sm text-wx-mute">No rules defined.</p>
        ) : (
          <ul className="space-y-6">
            {rules.map((rule) => {
              const tplName =
                rule.templates &&
                typeof rule.templates === 'object' &&
                'name' in rule.templates &&
                typeof (rule.templates as { name: string }).name === 'string'
                  ? (rule.templates as { name: string }).name
                  : null;
              const rf = rule.region_filter as RegionFilter | null;
              const rfIds = rf?.region_ids ?? [];

              return (
                <li key={rule.id} className="border border-wx-line rounded-lg p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{rule.event_pattern}</div>
                    <div className="flex flex-wrap items-center gap-4 text-sm">
                      <RuleToggle ruleId={rule.id} enabled={rule.enabled} />
                      <form action={deleteAutoRuleAction}>
                        <input type="hidden" name="id" value={rule.id} />
                        <button type="submit" className="text-wx-danger text-sm underline">
                          Delete
                        </button>
                      </form>
                    </div>
                  </div>
                  <div className="text-xs text-wx-mute flex flex-wrap gap-3">
                    <span>
                      Mode: <strong className="text-wx-fg">{rule.mode}</strong>
                    </span>
                    <span>
                      Template:{' '}
                      <strong className="text-wx-fg">
                        {tplName ?? (rule.template_id ? rule.template_id.slice(0, 8) : '—')}
                      </strong>
                    </span>
                    <span>
                      Min severity:{' '}
                      <strong className="text-wx-fg">{rule.min_severity ?? 'any'}</strong>
                    </span>
                  </div>
                  {rfIds.length > 0 ? (
                    <div className="text-xs text-wx-mute">
                      Regions:{' '}
                      {rfIds.map((id) => regionName.get(id) ?? id).join(', ')}
                    </div>
                  ) : (
                    <div className="text-xs text-wx-mute">Regions: all (no filter)</div>
                  )}

                  <details className="text-sm">
                    <summary className="cursor-pointer text-wx-accent">Edit</summary>
                    <form action={updateAutoRule} className="grid gap-3 sm:grid-cols-2 mt-3">
                      <input type="hidden" name="rule_id" value={rule.id} />
                      <label className="block text-sm sm:col-span-2">
                        <span className="text-wx-mute">Event pattern</span>
                        <input
                          name="event_pattern"
                          className="mt-1 w-full input"
                          defaultValue={rule.event_pattern}
                          required
                        />
                      </label>
                      <label className="block text-sm">
                        <span className="text-wx-mute">Min severity</span>
                        <select
                          name="min_severity"
                          className="mt-1 w-full input"
                          defaultValue={rule.min_severity ?? ''}
                        >
                          <option value="">Any</option>
                          <option value="minor">Minor</option>
                          <option value="moderate">Moderate</option>
                          <option value="severe">Severe</option>
                          <option value="extreme">Extreme</option>
                        </select>
                      </label>
                      <label className="block text-sm">
                        <span className="text-wx-mute">Mode</span>
                        <select name="mode" className="mt-1 w-full input" defaultValue={rule.mode} required>
                          <option value="review">Review</option>
                          <option value="auto">Auto-send</option>
                          <option value="ignore">Ignore</option>
                        </select>
                      </label>
                      <label className="block text-sm sm:col-span-2">
                        <span className="text-wx-mute">Template</span>
                        <select
                          name="template_id"
                          className="mt-1 w-full input"
                          defaultValue={rule.template_id ?? ''}
                        >
                          <option value="">—</option>
                          {(templates ?? []).map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="sm:col-span-2">
                        <span className="text-wx-mute text-sm">Regions</span>
                        <div className="mt-2 max-h-36 overflow-y-auto border border-wx-line rounded p-2 grid sm:grid-cols-2 gap-2">
                          {(regions ?? []).map((r) => (
                            <label key={r.id} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                name="region_ids"
                                value={r.id}
                                defaultChecked={rfIds.includes(r.id)}
                              />
                              <span className="truncate">{r.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="sm:col-span-2">
                        <button type="submit" className="btn">
                          Save changes
                        </button>
                      </div>
                    </form>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </DashShell>
  );
}
