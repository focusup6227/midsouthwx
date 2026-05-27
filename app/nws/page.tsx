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
import NwsAlertFilters, { type NwsListFilters } from './NwsAlertFilters';
import DashShell from '@/components/DashShell';
import {
  NWS_SEVERITIES,
  NWS_STATUSES,
  SEVERITY_TONE,
  STATUS_TONE,
  classifyAlertSeverity,
  relTime,
  sanitizeSearchQ,
} from '@/lib/nws/display';

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
  raw: unknown;
};

type CapAlertRow = {
  id: string;
  uri: string;
  parsed_event: string | null;
  title: string | null;
  severity: string | null;
  regions: string | null;
  status: string;
  expires_at: string | null;
  ingested_at: string;
};

function parseFilters(searchParams?: {
  status?: string;
  severity?: string;
  q?: string;
  active?: string;
}): NwsListFilters {
  const status = NWS_STATUSES.includes(searchParams?.status as (typeof NWS_STATUSES)[number])
    ? (searchParams!.status as (typeof NWS_STATUSES)[number])
    : null;
  const severity = NWS_SEVERITIES.includes(searchParams?.severity as (typeof NWS_SEVERITIES)[number])
    ? (searchParams!.severity as (typeof NWS_SEVERITIES)[number])
    : null;
  const q = searchParams?.q ? sanitizeSearchQ(searchParams.q) : null;
  const activeOnly = searchParams?.active === '1';
  return { status: activeOnly ? 'new' : status, severity, q, activeOnly };
}

export default async function NwsPage({
  searchParams,
}: {
  searchParams?: { status?: string; severity?: string; q?: string; active?: string };
}) {
  const supa = supabaseServer();
  const filters = parseFilters(searchParams);

  let alertsQ = supa
    .from('nws_alerts')
    .select(
      'id, nws_id, event, severity, headline, area_desc, status, expires_at, ingested_at, raw',
    )
    .order('ingested_at', { ascending: false })
    .limit(100);

  if (filters.status) alertsQ = alertsQ.eq('status', filters.status);
  if (filters.severity) alertsQ = alertsQ.eq('severity', filters.severity);
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    alertsQ = alertsQ.or(
      `event.ilike.${pattern},headline.ilike.${pattern},area_desc.ilike.${pattern}`,
    );
  }

  const [
    { data: alerts },
    { data: capAlerts },
    { data: pendingMsgs },
    { data: rules },
    { data: templates },
    { data: regions },
    statusCountsResults,
  ] = await Promise.all([
    alertsQ,
    // Recent CAP alerts (LibreWxR). No filter controls for now — the volume
    // is similar to NWS but the schema diffs (parsed_event, regions) make
    // shared filters awkward. Smaller cap (25) since this is a side-by-side
    // verification view, not the operator's primary list.
    supa
      .from('cap_alerts')
      .select('id, uri, parsed_event, title, severity, regions, status, expires_at, ingested_at')
      .order('ingested_at', { ascending: false })
      .limit(25),
    // Pending approvals span both pipelines now (cap-dispatcher can create
    // pending_approval rows too once CAP_DISPATCHER_ENABLED is flipped).
    supa
      .from('messages')
      .select(
        'id, body_md, recipient_count, created_at, source, nws_alert_id, cap_alert_id, quick_replies, auto_send_at',
      )
      .in('source', ['nws', 'cap'])
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
    // Single-roundtrip status rollup — replaces the previous 6 sequential
    // count: 'exact' queries with one RPC that grouped them in SQL.
    supa.rpc('nws_status_counts'),
  ]);

  const statusCountRows =
    (statusCountsResults.data as { status: string; count: number }[] | null) ?? [];
  const statusCounts = new Map<string, number>(
    NWS_STATUSES.map((s) => [s, statusCountRows.find((r) => r.status === s)?.count ?? 0]),
  );
  const regionName = new Map((regions ?? []).map((r) => [r.id, r.name]));

  const totalAlerts = Array.from(statusCounts.values()).reduce((s, n) => s + n, 0);
  const hasListFilters = !!filters.severity || !!filters.q || !!filters.status || filters.activeOnly;

  return (
    <DashShell title="NWS automation">
      <NwsRefresher />

      <p className="text-sm text-wx-mute">
        {totalAlerts} alerts tracked · live national poll every minute · matches against
        subscriber location/county/forecast zone. Rows older than 90 days are pruned nightly.
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
          <p className="text-sm text-wx-mute">No alert messages awaiting approval.</p>
        ) : (
          <ul className="divide-y divide-wx-line">
            {pendingMsgs.map((m) => (
              <li key={m.id} className="py-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span
                        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold ${
                          m.source === 'cap'
                            ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        }`}
                      >
                        {m.source === 'cap' ? 'LibreWxR' : 'NWS'}
                      </span>
                      {m.auto_send_at ? (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-wx-danger/20 text-wx-danger border border-wx-danger/50">
                          Auto-send armed
                        </span>
                      ) : null}
                      <Link href={`/alerts/${m.id}`} className="text-wx-accent text-sm font-medium">
                        Open message →
                      </Link>
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-sm mt-1 text-wx-fg/90 max-h-32 overflow-y-auto">
                      {m.body_md}
                    </pre>
                    <div className="text-xs text-wx-mute mt-1">
                      {m.recipient_count ?? 0} matched subscribers ·{' '}
                      {new Date(m.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <NwsApproveButtons messageId={m.id} autoSendAt={m.auto_send_at ?? null} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5 space-y-4">
        <h2 className="font-semibold">Recent NWS alerts</h2>
        <NwsAlertFilters
          filters={filters}
          statusCounts={statusCounts}
          totalAlerts={totalAlerts}
        />
        {!alerts?.length ? (
          <p className="text-sm text-wx-mute">
            {hasListFilters
              ? 'No alerts match these filters.'
              : 'No alerts in this view. Poll runs every minute; check back shortly.'}
          </p>
        ) : (
          <ul className="divide-y divide-wx-line">
            {(alerts as AlertRow[]).map((a) => {
              const sevTone = SEVERITY_TONE[a.severity ?? 'Unknown'] ?? SEVERITY_TONE.Unknown;
              const statusTone = STATUS_TONE[a.status] ?? '';
              const severeFlags = classifyAlertSeverity(a.raw, a.event);
              return (
                <li key={a.id} className="py-3">
                  <Link
                    href={`/nws/${a.id}`}
                    className="flex items-start gap-3 flex-wrap rounded-lg -mx-2 px-2 py-1 hover:bg-wx-line/30 transition-colors"
                  >
                    <span
                      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${sevTone}`}
                    >
                      {a.severity ?? '?'}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${statusTone}`}
                    >
                      {a.status}
                    </span>
                    {severeFlags.isTornadoEmergency ? (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold bg-wx-danger text-black animate-pulse"
                        title="Tornado Emergency — confirmed tornado with catastrophic damage threat"
                      >
                        ⚠ TOR EMERGENCY
                      </span>
                    ) : severeFlags.isPds ? (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold bg-wx-danger/80 text-black"
                        title="Particularly Dangerous Situation — considerable or destructive damage threat"
                      >
                        PDS
                      </span>
                    ) : null}
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
                      <span className="text-wx-accent">Details →</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Recent CAP alerts (LibreWxR)</h2>
            <p className="text-sm text-wx-mute">
              Parallel-pipeline ingestion. Stays inert until{' '}
              <code className="text-wx-fg">CAP_DISPATCHER_ENABLED=1</code> is set.
              Polygon-only audience matching — no UGC/SAME fallback.
            </p>
          </div>
          <span className="text-xs text-wx-mute font-mono">
            {(capAlerts ?? []).length} of last 25
          </span>
        </div>
        {!capAlerts?.length ? (
          <p className="text-sm text-wx-mute">
            No CAP alerts ingested yet. <code>librewxr-poll</code> runs every minute — check back shortly.
          </p>
        ) : (
          <ul className="divide-y divide-wx-line">
            {(capAlerts as CapAlertRow[]).map((a) => {
              const sevTone = SEVERITY_TONE[a.severity ?? 'Unknown'] ?? SEVERITY_TONE.Unknown;
              const statusTone = STATUS_TONE[a.status] ?? '';
              return (
                <li key={a.id} className="py-3">
                  <div className="flex items-start gap-3 flex-wrap rounded-lg -mx-2 px-2 py-1">
                    <span
                      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${sevTone}`}
                    >
                      {a.severity ?? 'Unknown'}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${statusTone}`}
                    >
                      {a.status}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {a.parsed_event ?? '(unparsed)'}
                      </div>
                      <div className="text-xs text-wx-mute truncate" title={a.title ?? ''}>
                        {a.title ?? a.uri}
                      </div>
                      {a.regions ? (
                        <div className="text-xs text-wx-mute mt-0.5 truncate" title={a.regions}>
                          {a.regions}
                        </div>
                      ) : null}
                    </div>
                    <div className="text-right text-xs text-wx-mute shrink-0">
                      <div>ingested {relTime(a.ingested_at)}</div>
                      {a.expires_at ? (
                        <div>{relTime(a.expires_at, { future: true })}</div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section id="rules" className="card p-5 space-y-4 scroll-mt-20">
        <h2 className="font-semibold">Auto-alert rules</h2>
        <p className="text-sm text-wx-mute">
          First matching rule wins (stable order by created time). Patterns match{' '}
          <code className="text-wx-fg">properties.event</code> exactly, or use a trailing{' '}
          <code className="text-wx-fg">*</code> for prefix match. Shared across both NWS and
          CAP dispatchers.
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
