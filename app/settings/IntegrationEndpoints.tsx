'use client';

import { useState, useTransition } from 'react';
import {
  createIntegrationEndpoint,
  deleteIntegrationEndpoint,
  testIntegrationEndpoint,
  toggleIntegrationEndpoint,
  updateIntegrationEndpoint,
  type TestPingResult,
} from './integration-actions';

type Endpoint = {
  id: string;
  name: string;
  url: string;
  severity_threshold: string | null;
  enabled: boolean;
  created_at: string;
};

export default function IntegrationEndpoints({
  endpoints,
  severityOptions,
}: {
  endpoints: Endpoint[];
  severityOptions: readonly string[];
}) {
  const [pending, startTransition] = useTransition();
  const [testResult, setTestResult] = useState<TestPingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onTest = (id: string) => {
    setError(null);
    setTestResult(null);
    startTransition(async () => {
      try {
        const res = await testIntegrationEndpoint(id);
        setTestResult(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Test failed');
      }
    });
  };

  const onToggle = (id: string, enabled: boolean) => {
    startTransition(async () => {
      try {
        await toggleIntegrationEndpoint(id, enabled);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Toggle failed');
      }
    });
  };

  return (
    <div className="space-y-4">
      {endpoints.length ? (
        <ul className="divide-y divide-wx-line">
          {endpoints.map((ep) => (
            <li key={ep.id} className="py-4 first:pt-0 last:pb-0 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{ep.name}</div>
                  <div className="text-xs text-wx-mute truncate">{ep.url}</div>
                  <div className="text-xs text-wx-mute mt-1">
                    {ep.enabled ? 'Enabled' : 'Disabled'}
                    {ep.severity_threshold ? ` · min ${ep.severity_threshold}` : ' · all severities'}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    disabled={pending}
                    onClick={() => onTest(ep.id)}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    disabled={pending}
                    onClick={() => onToggle(ep.id, !ep.enabled)}
                  >
                    {ep.enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-wx-accent">Edit</summary>
                <form action={updateIntegrationEndpoint} className="mt-3 space-y-2">
                  <input type="hidden" name="id" value={ep.id} />
                  <input className="input" name="name" defaultValue={ep.name} required />
                  <input className="input" name="url" defaultValue={ep.url} required type="url" />
                  <input
                    className="input"
                    name="secret"
                    type="password"
                    placeholder="Leave blank to keep existing secret"
                    autoComplete="off"
                  />
                  <select
                    className="input max-w-xs"
                    name="severity_threshold"
                    defaultValue={ep.severity_threshold ?? ''}
                  >
                    {severityOptions.map((s) => (
                      <option key={s || 'all'} value={s}>
                        {s || 'All severities'}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="enabled" defaultChecked={ep.enabled} />
                    Enabled
                  </label>
                  <button type="submit" className="btn-ghost text-sm">
                    Save
                  </button>
                </form>
                <form action={deleteIntegrationEndpoint} className="mt-2">
                  <input type="hidden" name="id" value={ep.id} />
                  <button
                    type="submit"
                    className="btn-ghost text-xs text-wx-danger border-wx-danger/40"
                    onClick={(e) => {
                      if (!confirm(`Delete endpoint "${ep.name}"?`)) e.preventDefault();
                    }}
                  >
                    Delete
                  </button>
                </form>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-wx-mute text-sm">No integration endpoints yet.</p>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-wx-accent font-medium">Add endpoint</summary>
        <form action={createIntegrationEndpoint} className="mt-3 space-y-2">
          <input className="input" name="name" placeholder="County EMA webhook" required />
          <input className="input" name="url" placeholder="https://…" required type="url" />
          <input
            className="input"
            name="secret"
            type="password"
            placeholder="HMAC secret (optional)"
            autoComplete="off"
          />
          <select className="input max-w-xs" name="severity_threshold" defaultValue="">
            {severityOptions.map((s) => (
              <option key={s || 'all'} value={s}>
                {s || 'All severities'}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked />
            Enabled
          </label>
          <button type="submit" className="btn text-sm">
            Add endpoint
          </button>
        </form>
      </details>

      {testResult && (
        <div className="text-sm rounded-lg border border-wx-line p-3 space-y-1">
          {testResult.results.map((r) => (
            <div key={r.endpoint_name} className={r.ok ? 'text-wx-ok' : 'text-wx-danger'}>
              {r.endpoint_name}: {r.status}
            </div>
          ))}
        </div>
      )}
      {error && <div className="text-sm text-wx-danger">{error}</div>}
    </div>
  );
}
