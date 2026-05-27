'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { bulkImportRegions } from './actions';
import { FIPS_TO_ABBR } from '@/lib/regions/states';
import type { ImportResult } from '@/lib/regions/import';

const STATES = Object.entries(FIPS_TO_ABBR)
  .map(([fips, abbr]) => ({ fips, abbr }))
  .sort((a, b) => a.abbr.localeCompare(b.abbr));

const MID_SOUTH = new Set(['TN', 'MS', 'AR']);

export default function BulkImportForm() {
  const [kind, setKind] = useState<'counties' | 'zones'>('counties');
  const [selected, setSelected] = useState<Set<string>>(new Set(MID_SOUTH));
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = (abbr: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(abbr)) next.delete(abbr);
      else next.add(abbr);
      return next;
    });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResults(null);
    if (selected.size === 0) {
      setError('Pick at least one state.');
      return;
    }
    const states = Array.from(selected);
    start(async () => {
      try {
        const out = await bulkImportRegions({ kind, states });
        if (!out.ok) {
          setError(out.error ?? 'Import failed.');
          return;
        }
        setResults(out.results);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="card p-5 space-y-5">
      <div>
        <div className="text-xs uppercase tracking-wide text-wx-mute mb-2">Source</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setKind('counties')}
            className={`btn-ghost text-sm ${kind === 'counties' ? 'border-wx-accent text-wx-accent' : ''}`}
          >
            Counties (Census TIGER)
          </button>
          <button
            type="button"
            onClick={() => setKind('zones')}
            className={`btn-ghost text-sm ${kind === 'zones' ? 'border-wx-accent text-wx-accent' : ''}`}
          >
            NWS forecast zones
          </button>
        </div>
        <p className="mt-2 text-xs text-wx-mute">
          {kind === 'counties' ? (
            <>Pulls county polygons from Census TIGERweb. Fast — one fetch per state.</>
          ) : (
            <>
              Pulls forecast-zone polygons from <code>api.weather.gov</code>. Slower — ~80
              fetches per state, polite concurrency. Needs <code>NWS_USER_AGENT</code>.
            </>
          )}
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-wx-mute">States</div>
          <div className="flex gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => setSelected(new Set(MID_SOUTH))}
              className="text-wx-mute hover:text-wx-fg"
            >
              Mid-South
            </button>
            <span className="text-wx-line">|</span>
            <button
              type="button"
              onClick={() => setSelected(new Set(STATES.map((s) => s.abbr)))}
              className="text-wx-mute hover:text-wx-fg"
            >
              All
            </button>
            <span className="text-wx-line">|</span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-wx-mute hover:text-wx-fg"
            >
              None
            </button>
          </div>
        </div>
        <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto rounded border border-wx-line p-2 sm:grid-cols-6 md:grid-cols-8">
          {STATES.map(({ abbr }) => {
            const on = selected.has(abbr);
            return (
              <button
                type="button"
                key={abbr}
                onClick={() => toggle(abbr)}
                className={`rounded border px-2 py-1 text-sm font-mono ${
                  on ? 'border-wx-accent text-wx-accent bg-wx-accent/10' : 'border-wx-line text-wx-mute'
                }`}
              >
                {abbr}
              </button>
            );
          })}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-wx-danger">{error}</p>
      ) : null}

      {results ? (
        <div className="rounded border border-wx-line">
          <div className="border-b border-wx-line px-3 py-2 text-xs uppercase tracking-wide text-wx-mute">
            Results
          </div>
          <ul className="divide-y divide-wx-line text-sm">
            {results.map((r, i) => (
              <li key={`${r.state}-${i}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="font-mono">{r.state}</span>
                <span className={r.error ? 'text-wx-danger' : 'text-wx-mute'}>
                  {r.error
                    ? r.error
                    : `${r.upserted} upserted${r.failed ? ` · ${r.failed} failed` : ''}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Link href="/regions" className="btn-ghost text-sm">Back</Link>
        <button type="submit" disabled={pending} className="btn">
          {pending ? 'Importing…' : `Import ${selected.size} state${selected.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </form>
  );
}
