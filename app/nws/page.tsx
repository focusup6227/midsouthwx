import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import {
  createAutoRule,
  deleteAutoRuleAction,
  updateAutoRule,
} from './actions';
import RuleToggle from './RuleToggle';
import DashShell from '@/components/DashShell';

export const dynamic = 'force-dynamic';

type RegionFilter = { region_ids?: string[] };

export default async function NwsPage() {
  const supa = supabaseServer();

  const [
    { data: alerts },
    { data: pendingMsgs },
    { data: rules },
    { data: templates },
    { data: regions },
  ] = await Promise.all([
    supa
      .from('nws_alerts')
      .select(
        'id, nws_id, event, severity, headline, status, expires_at, ingested_at',
      )
      .order('ingested_at', { ascending: false })
      .limit(75),
    supa
      .from('messages')
      .select('id, body_md, recipient_count, created_at, nws_alert_id')
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
  ]);

  const regionName = new Map((regions ?? []).map((r) => [r.id, r.name]));

  return (
    <DashShell title="NWS automation">
      <p className="text-sm text-wx-mute">
        Active alerts from the national poll, pending approvals, and routing rules.
      </p>

      <section className="card p-5 space-y-4">
        <h2 className="font-semibold">Pending approvals</h2>
        {!pendingMsgs?.length ? (
          <p className="text-sm text-wx-mute">No NWS messages awaiting approval.</p>
        ) : (
          <ul className="divide-y divide-wx-line">
            {pendingMsgs.map((m) => (
              <li key={m.id} className="py-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <Link href={`/alerts/${m.id}`} className="text-wx-accent font-medium">
                    Open message
                  </Link>
                  <pre className="whitespace-pre-wrap font-sans text-sm mt-1 text-wx-fg/90 line-clamp-3">
                    {m.body_md}
                  </pre>
                  <div className="text-xs text-wx-mute mt-1">
                    {m.recipient_count ?? 0} matched subscribers ·{' '}
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5 space-y-4">
        <h2 className="font-semibold">Recent NWS alerts</h2>
        {!alerts?.length ? (
          <p className="text-sm text-wx-mute">No rows yet (poll runs every minute when deployed).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-wx-mute border-b border-wx-line">
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Event</th>
                  <th className="pb-2 pr-3">Headline</th>
                  <th className="pb-2 pr-3">Expires</th>
                  <th className="pb-2">API</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-wx-line">
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2 pr-3 whitespace-nowrap">{a.status}</td>
                    <td className="py-2 pr-3">{a.event}</td>
                    <td className="py-2 pr-3 max-w-xs truncate">{a.headline ?? '—'}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-wx-mute">
                      {a.expires_at ? new Date(a.expires_at).toLocaleString() : '—'}
                    </td>
                    <td className="py-2">
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
                        View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
